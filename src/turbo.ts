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
import { TurboFactory } from '@ardrive/turbo-sdk';
import { ArweaveSigner, createData } from 'arbundles/node';
import * as fs from 'node:fs';
import { JWKInterface } from 'warp-contracts/mjs';

import { KEY_FILE } from './config.js';

// load your JWK from a file or generate a new oneW
const jwk: JWKInterface = JSON.parse(fs.readFileSync(KEY_FILE).toString());

const turbo = TurboFactory.authenticated({ privateKey: jwk });

export async function uploadReportViaTurbo(report: any): Promise<string> {
  let reportTxId = '';
  // Convert the JSON object to a JSON string
  const reportString = JSON.stringify(report);
  try {
    const signer = new ArweaveSigner(jwk);
    const signedDataItem = createData(reportString, signer, {});
    await signedDataItem.sign(signer);

    const { id, owner, dataCaches, fastFinalityIndexes } =
      await turbo.uploadSignedDataItem({
        dataItemStreamFactory: () => signedDataItem.getRaw(),
        dataItemSizeFactory: () => signedDataItem.getRaw().length,
      });

    // upload complete!
    console.log('Successfully upload data item!', {
      id,
      owner,
      dataCaches,
      fastFinalityIndexes,
    });
    reportTxId = id;
  } catch (error) {
    // upload failed
    console.error('Failed to upload data item!', error);
  } finally {
    const { winc: newBalance } = await turbo.getBalance();
    console.log('New balance:', newBalance);
  }
  return reportTxId;
}
