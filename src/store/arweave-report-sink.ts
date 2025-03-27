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
import Arweave from 'arweave';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import * as winston from 'winston';

import { REPORT_FORMAT_VERSION } from '../observer.js';
import { ObserverReport, ReportInfo, ReportSink } from '../types.js';

const gzip = promisify(zlib.gzip);

export class ArweaveReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;
  private arweave: Arweave;
  private readonly walletJwk: any; // JWK wallet type

  constructor({
    log,
    arweave,
    walletJwk,
  }: {
    log: winston.Logger;
    arweave: Arweave;
    walletJwk: any;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arweave = arweave;
    this.walletJwk = walletJwk;
  }

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo> {
    const { report } = reportInfo;
    const log = this.log.child({
      epochStartTimestamp: report.epochStartTimestamp,
      epochIndex: report.epochIndex,
      epochStartHeight: report.epochStartHeight,
    });

    try {
      // Return existing TX ID if the report was already saved
      const existingTxId = await this.getReportTxId(report);
      if (existingTxId !== undefined) {
        log.verbose('Report already saved, skipping upload');
        return {
          ...reportInfo,
          reportTxId: existingTxId,
        };
      }

      // Compress the report data
      const reportBuffer = Buffer.from(JSON.stringify(report), 'utf-8');
      const gzipReportBuffer = await gzip(reportBuffer);

      // Create and configure the transaction
      const transaction = await this.arweave.createTransaction(
        { data: gzipReportBuffer },
        this.walletJwk,
      );

      // Add tags
      transaction.addTag('App-Name', 'AR-IO Observer');
      transaction.addTag('App-Version', '0.0.1');
      transaction.addTag('Content-Type', 'application/json');
      transaction.addTag('Content-Encoding', 'gzip');
      transaction.addTag('AR-IO-Component', 'observer');
      transaction.addTag(
        'AR-IO-Epoch-Start-Height',
        report.epochStartHeight.toString(),
      );
      transaction.addTag(
        'AR-IO-Epoch-Start-Timestamp',
        report.epochStartTimestamp.toString(),
      );
      transaction.addTag('AR-IO-Epoch-Index', report.epochIndex.toString());
      transaction.addTag(
        'AR-IO-Observer-Report-Version',
        REPORT_FORMAT_VERSION.toString(),
      );

      // Sign transaction
      await this.arweave.transactions.sign(transaction, this.walletJwk);

      // Submit transaction
      const uploader = await this.arweave.transactions.getUploader(transaction);
      while (!uploader.isComplete) {
        await uploader.uploadChunk();
        log.debug(`Upload progress: ${uploader.pctComplete}%`);
      }

      log.verbose('Report saved to Arweave', { txId: transaction.id });

      return {
        ...reportInfo,
        reportTxId: transaction.id,
      };
    } catch (error) {
      throw new Error(`Error saving report: ${error}`);
    }
  }

  private async getReportTxId(
    report: ObserverReport,
  ): Promise<string | undefined> {
    const walletAddress = await this.arweave.wallets.jwkToAddress(
      this.walletJwk,
    );

    // Find the first report TX ID for the given epoch parameters and format version
    const queryObject = {
      query: `{
        transactions(
          sort: HEIGHT_ASC,
          first:1,
          owners: [ "${walletAddress}" ],
          tags: [
            { name: "App-Name", values: ["AR-IO Observer"] },
            { name: "Content-Type", values: [ "application/json" ] },
            { name: "AR-IO-Epoch-Start-Height", values: [ "${report.epochStartHeight}" ]},
            { name: "AR-IO-Epoch-Index", values: [ "${report.epochIndex}" ] },
            { name: "AR-IO-Epoch-Start-Timestamp", values: [ "${report.epochStartTimestamp}" ]},
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
