/**
 * AR.IO Observer
 * Copyright (C) 2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { TurboAuthenticatedClient } from '@ardrive/turbo-sdk/node';
import { Signer, createData } from '@dha-team/arbundles/node';
import Arweave from 'arweave';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import * as winston from 'winston';

import { REPORT_FORMAT_VERSION } from '../observer.js';
import { ObserverReport, ReportInfo, ReportSink } from '../types.js';

const gzip = promisify(zlib.gzip);

async function createReportDataItem(signer: Signer, report: ObserverReport) {
  const reportBuffer = Buffer.from(JSON.stringify(report), 'utf-8');
  const gzipReportBuffer = await gzip(reportBuffer, { level: 9 });
  const signedDataItem = createData(gzipReportBuffer, signer, {
    tags: [
      { name: 'App-Name', value: 'AR-IO Observer' },
      { name: 'App-Version', value: '0.0.1' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Content-Encoding', value: 'gzip' },
      {
        name: 'AR-IO-Component',
        value: 'observer',
      },
      {
        name: 'AR-IO-Epoch-Start-Height',
        value: report.epochStartHeight.toString(),
      },
      {
        name: 'AR-IO-Epoch-Start-Timestamp',
        value: report.epochStartTimestamp.toString(),
      },
      {
        name: 'AR-IO-Epoch-Index',
        value: report.epochIndex.toString(),
      },
      {
        name: 'AR-IO-Observer-Report-Version',
        value: REPORT_FORMAT_VERSION.toString(),
      },
    ],
  });
  await signedDataItem.sign(signer);

  return signedDataItem;
}

/**
 * Compute the Arweave-normalized owner address for any arbundles signer.
 *
 * Arweave GraphQL's `owners` filter expects 43-char base64url addresses
 * (`base64url(SHA-256(publicKey))`), regardless of chain. For
 * `ArweaveSigner` this is the canonical Arweave address (SHA-256 of the
 * RSA modulus). For `SolanaSigner` / `EthereumSigner` Turbo's ANS-104
 * pipeline derives the same shape from the raw 32-byte / 65-byte
 * pubkey, so the data item's stored owner matches `SHA-256(pubkey)`
 * base64url. Computing it here lets dedupe queries hit regardless of
 * which upload chain the operator chose, without us needing to add a
 * sidecar tag.
 *
 * Exported for unit testing.
 */
export function signerOwnerAddress(signer: Signer): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pubkey = (signer as any).publicKey as Buffer;
  return crypto
    .createHash('sha256')
    .update(pubkey)
    .digest()
    .toString('base64url');
}

// TODO implement full ReportStore interface
export class TurboReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;
  private arweave: Arweave;
  private readonly turboClient: TurboAuthenticatedClient;
  // Generalized to the arbundles `Signer` base class so the sink works with
  // any chain Turbo accepts (ArweaveSigner / SolanaSigner / EthereumSigner).
  // The concrete construction lives in system.ts based on the resolved
  // UploadIdentity.
  private readonly signer: Signer;

  constructor({
    log,
    arweave,
    turboClient,
    signer,
  }: {
    log: winston.Logger;
    arweave: Arweave;
    turboClient: TurboAuthenticatedClient;
    signer: Signer;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arweave = arweave;
    this.turboClient = turboClient;
    this.signer = signer;
  }

  async saveReport(reportInfo: ReportInfo): Promise<{
    report: ObserverReport;
    reportTxId: string;
  }> {
    const { report } = reportInfo;
    const log = this.log.child({
      epochStartTimestamp: report.epochStartTimestamp,
      epochIndex: report.epochIndex,
      epochStartHeight: report.epochStartHeight,
    });

    // Return existing TX ID if the report was already saved
    try {
      const reportTxId = await this.getReportTxId(report);
      if (reportTxId !== undefined) {
        log.verbose('Report already saved, skipping upload');
        return {
          ...reportInfo,
          reportTxId,
        };
      }
    } catch (error: any) {
      log.error('Error checking for existing report', {
        message: error.message,
        stack: error.stack,
      });
    }

    // Upload the report as a data item using Turbo
    try {
      log.debug('Saving report...');

      // Sign and upload data item
      const signedDataItem = await createReportDataItem(this.signer, report);
      const { id, owner, dataCaches, fastFinalityIndexes } =
        await this.turboClient.uploadSignedDataItem({
          dataItemStreamFactory: () => signedDataItem.getRaw(),
          dataItemSizeFactory: () => signedDataItem.getRaw().length,
        });

      log.verbose('Report saved using Turbo', {
        id,
        owner,
        dataCaches,
        fastFinalityIndexes,
      });

      // Return the report info with TX ID added
      return {
        ...reportInfo,
        reportTxId: id,
      };
    } catch (error) {
      throw new Error(`Error saving report: ${error}`);
    } finally {
      const { winc: newBalance } = await this.turboClient.getBalance();
      log.verbose(`New Turbo balance: ${newBalance}`, {
        newBalance,
      });
    }
  }

  async getReportTxId(report: ObserverReport): Promise<string | undefined> {
    const epochStartTimestamp = report.epochStartTimestamp;
    const epochStartHeight = report.epochStartHeight;
    const epochIndex = report.epochIndex;

    // Find the first report TX ID for this signer + epoch. The owner
    // filter is derived from the signer (SHA-256 of pubkey, base64url)
    // so the same query works for ArweaveSigner / SolanaSigner /
    // EthereumSigner. The human-readable label (`walletAddress`) varies
    // by chain (Arweave addr / Solana base58 pubkey / 0x-hex) and would
    // not match here for the non-Arweave chains.
    const ownerAddress = signerOwnerAddress(this.signer);
    const queryObject = {
      query: `{
        transactions(
          sort: HEIGHT_ASC,
          first:1,
          owners: [ "${ownerAddress}" ],
          tags: [
            { name: "App-Name", values: ["AR-IO Observer"] },
            { name: "Content-Type", values: [ "application/json" ] },
            { name: "AR-IO-Epoch-Start-Height", values: [ "${epochStartHeight}" ]},
            { name: "AR-IO-Epoch-Index", values: [ "${epochIndex}" ] }
            { name: "AR-IO-Epoch-Start-Timestamp", values: [ "${epochStartTimestamp}" ]},
            { name: "AR-IO-Observer-Report-Version", values: [ "${REPORT_FORMAT_VERSION}" ] }
          ]
        )
        {
          edges {
            node {
              id
            }
          }
        }
      }`,
    };

    const response = await this.arweave.api.post('/graphql', queryObject);

    // Return the first report TX ID if it exists
    const edges = response?.data?.data?.transactions?.edges;
    if (Array.isArray(edges)) {
      return edges[0]?.node?.id;
    } else {
      return undefined;
    }
  }
}
