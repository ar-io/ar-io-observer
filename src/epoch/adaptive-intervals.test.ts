/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';

import { deriveCrankIntervals } from './adaptive-intervals.js';

// Input unit is SECONDS (matches on-chain EpochSettings.epochDuration).
const MIN_S = 60;
const HOUR_S = 60 * MIN_S;
// Output unit is MILLISECONDS.
const SEC_MS = 1000;
const MIN_MS = 60 * SEC_MS;

describe('deriveCrankIntervals', () => {
  it('reproduces the proven 24h production values (60s poll / 30min cleanup)', () => {
    expect(deriveCrankIntervals(24 * HOUR_S)).to.deep.equal({
      pollIntervalMs: 60 * SEC_MS,
      cleanupMinIntervalMs: 30 * MIN_MS,
    });
  });

  it('scales cleanup down but keeps the poll ceiling at 12h', () => {
    expect(deriveCrankIntervals(12 * HOUR_S)).to.deep.equal({
      pollIntervalMs: 60 * SEC_MS, // ceiling
      cleanupMinIntervalMs: 15 * MIN_MS,
    });
  });

  it('matches the previous fixed defaults at 1h (15s poll / 5min cleanup)', () => {
    expect(deriveCrankIntervals(1 * HOUR_S)).to.deep.equal({
      pollIntervalMs: 15 * SEC_MS,
      cleanupMinIntervalMs: 5 * MIN_MS, // floor
    });
  });

  it('floors both at short (10min) epochs — poll floor is <= the old 15s default (no regression)', () => {
    const { pollIntervalMs, cleanupMinIntervalMs } = deriveCrankIntervals(
      10 * MIN_S,
    );
    expect(pollIntervalMs).to.equal(10 * SEC_MS); // floor
    expect(cleanupMinIntervalMs).to.equal(5 * MIN_MS); // floor
    expect(pollIntervalMs).to.be.at.most(15 * SEC_MS);
  });

  it('clamps very long epochs to the ceilings', () => {
    expect(deriveCrankIntervals(100 * HOUR_S)).to.deep.equal({
      pollIntervalMs: 60 * SEC_MS,
      cleanupMinIntervalMs: 30 * MIN_MS,
    });
  });

  it('returns safe floors for unknown / invalid epoch durations', () => {
    const floors = {
      pollIntervalMs: 10 * SEC_MS,
      cleanupMinIntervalMs: 5 * MIN_MS,
    };
    expect(deriveCrankIntervals(0)).to.deep.equal(floors);
    expect(deriveCrankIntervals(-5)).to.deep.equal(floors);
    expect(deriveCrankIntervals(Number.NaN)).to.deep.equal(floors);
    expect(deriveCrankIntervals(Number.POSITIVE_INFINITY)).to.deep.equal(
      floors,
    );
  });

  it('never returns values outside the documented clamp bounds', () => {
    for (const durS of [0, 1, MIN_S, HOUR_S, 24 * HOUR_S, 1000 * HOUR_S]) {
      const { pollIntervalMs, cleanupMinIntervalMs } =
        deriveCrankIntervals(durS);
      expect(pollIntervalMs).to.be.within(10 * SEC_MS, 60 * SEC_MS);
      expect(cleanupMinIntervalMs).to.be.within(5 * MIN_MS, 30 * MIN_MS);
    }
  });
});
