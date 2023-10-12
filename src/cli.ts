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
import { OBSERVER_ADDRESS } from './config.js';
import {
  DEFAULT_EPOCH_BLOCK_LENGTH,
  DEFAULT_START_HEIGHT,
} from './protocol.js';
import {
  chosenObserversSource,
  epochHeightSelector,
  observer,
  prescribedObserversSource,
} from './system.js';

observer.generateReport().then((report) => {
  console.log(JSON.stringify(report, null, 2));
});

const chosenObservers = await chosenObserversSource.getObservers({
  startHeight: DEFAULT_START_HEIGHT,
  epochBlockLength: DEFAULT_EPOCH_BLOCK_LENGTH,
  height: await epochHeightSelector.getHeight(),
});
console.log('Number of randomly chosen observers: ', chosenObservers.length);
console.log(
  'Randomly chosen for observation? ',
  chosenObservers.includes(OBSERVER_ADDRESS),
);

const prescribedObservers = await prescribedObserversSource.getObservers({
  startHeight: DEFAULT_START_HEIGHT,
  epochBlockLength: DEFAULT_EPOCH_BLOCK_LENGTH,
  height: await epochHeightSelector.getHeight(),
});

console.log('Number of prescribed observers: ', prescribedObservers.length);
console.log(
  'Prescribed for observation? ',
  prescribedObservers.includes(OBSERVER_ADDRESS),
);
