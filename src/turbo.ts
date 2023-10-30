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
import { ArweaveSigner, createData } from 'arbundles/node';

import { ObserverReport, ReportSaveResult, ReportSink } from './types.js';

async function createReportDataItem(
  signer: ArweaveSigner,
  report: ObserverReport,
) {
  const signedDataItem = createData(JSON.stringify(report), signer, {
    tags: [
      { name: 'App-Name', value: 'AR-IO Observer' },
      { name: 'App-Version', value: '0.0.1' },
      { name: 'Content-Type', value: 'application/json' },
    ],
  });
  await signedDataItem.sign(signer);

  return signedDataItem;
}

// TODO implement full ReportStore interface
export class TurboReportStore implements ReportSink {
  private readonly turboClient: TurboAuthenticatedClient;
  private readonly signer: ArweaveSigner;

  constructor({
    turboClient,
    signer,
  }: {
    turboClient: TurboAuthenticatedClient;
    signer: ArweaveSigner;
  }) {
    this.turboClient = turboClient;
    this.signer = signer;
  }

  async saveReport(
    report: ObserverReport,
  ): Promise<ReportSaveResult | undefined> {
    try {
      const signedDataItem = await createReportDataItem(this.signer, report);

      // TODO skip uploading if the report already exists

      // Upload report using Turbo
      const { id, owner, dataCaches, fastFinalityIndexes } =
        await this.turboClient.uploadSignedDataItem({
          dataItemStreamFactory: () => signedDataItem.getRaw(),
          dataItemSizeFactory: () => signedDataItem.getRaw().length,
        });

      console.log('Successfully uploaded report to Turbo!', {
        id,
        owner,
        dataCaches,
        fastFinalityIndexes,
      });

      return {
        reportTxId: id,
      };
    } catch (error) {
      console.error('Failed to upload report to Turbo!', error);
    } finally {
      const { winc: newBalance } = await this.turboClient.getBalance();
      console.log('New balance:', newBalance);
    }

    return undefined;
  }
}

//export async function uploadReportFromDiskWithTurbo(
//  fileName: string,
//): Promise<string | null> {
//  if (jwk !== undefined && turbo !== undefined) {
//    const report = JSON.parse(fs.readFileSync(fileName).toString());
//    let reportTxId = '';
//    // Convert the JSON object to a JSON string
//    const reportString = JSON.stringify(report, null, 2);
//    try {
//      const signer = new ArweaveSigner(jwk);
//      const signedDataItem = createData(reportString, signer, {
//        tags,
//      });
//      await signedDataItem.sign(signer);
//
//      const { id, owner, dataCaches, fastFinalityIndexes } =
//        await turbo.uploadSignedDataItem({
//          dataItemStreamFactory: () => signedDataItem.getRaw(),
//          dataItemSizeFactory: () => signedDataItem.getRaw().length,
//        });
//
//      // upload complete!
//      console.log('Successfully uploaded data item from disk to Turbo!', {
//        id,
//        owner,
//        dataCaches,
//        fastFinalityIndexes,
//      });
//      reportTxId = id;
//    } catch (error) {
//      // upload failed
//      console.error('Failed to upload data item from disk to Turbo!', error);
//      return null;
//    } finally {
//      const { winc: newBalance } = await turbo.getBalance();
//      console.log('New balance:', newBalance);
//    }
//    return reportTxId;
//  } else {
//    console.error('Key missing, skipping upload');
//    return null;
//  }
//}
