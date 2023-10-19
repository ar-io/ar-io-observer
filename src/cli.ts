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
import { OBSERVER_WALLET } from './config.js';
import { EPOCH_BLOCK_LENGTH, START_HEIGHT } from './protocol.js';
import {
  epochHeightSelector,
  observer,
  prescribedObserversSource,
  publishObservation,
} from './system.js';
import { uploadReportWithTurbo } from './turbo.js';

const report = await observer.generateReport();
console.log(JSON.stringify(report, null, 2));

console.log('You are: ', OBSERVER_WALLET);
const prescribedObservers = await prescribedObserversSource.getObservers({
  startHeight: START_HEIGHT,
  epochBlockLength: EPOCH_BLOCK_LENGTH,
  height: await epochHeightSelector.getHeight(),
});

console.log('Number of prescribed observers: ', prescribedObservers.length);
console.log(
  'Prescribed for observation? ',
  prescribedObservers.includes(OBSERVER_WALLET),
);
console.log(prescribedObservers);

const observationReportObjectTxId = await uploadReportWithTurbo(report);
if (observationReportObjectTxId !== null) {
  const saveObservationTxIds = await publishObservation.saveObservations(
    observationReportObjectTxId,
    report,
  );
  console.log('Saved observation interaction IDs: ', saveObservationTxIds);
}
