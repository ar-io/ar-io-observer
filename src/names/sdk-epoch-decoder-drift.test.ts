/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';
import { getEpochDecoder } from '@ar.io/solana-contracts/gar';

/**
 * Regression guard for the stale-SDK Epoch-decoder bug.
 *
 * The observer reads prescribed observers + names through @ar.io/sdk's
 * `SolanaARIOReadable.getPrescribedNames()`, which decodes the ario-gar
 * `Epoch` account via the codama decoder bundled from
 * `@ar.io/solana-contracts`. `@ar.io/sdk@4.0.0-solana.24` bundled the
 * pre-ADR-024 `devnet-shrunk` client, whose `Epoch.failure_counts` was
 * `[u16; 30]` (60 bytes) instead of the deployed `[u16; 3000]` (6000 bytes).
 * That 5,940-byte under-count shifted every subsequent field, so
 * `prescribed_observers` / `prescribed_names` were read from zero-padding —
 * the decoder returned `1111…`/`0x00…` and the observer hard-gated forever
 * on "Prescribed names not yet available", never submitting an observation.
 *
 * The deployed `Epoch` account is 9,408 bytes (8-byte Anchor discriminator +
 * 9,400-byte struct, full-size on every cluster since devnet-shrunk was
 * retired — ADR-024). If a future bundled SDK regresses to a shrunk layout,
 * this fixed size changes and this test fails BEFORE it silently blinds the
 * observer again.
 */
describe('bundled @ar.io/solana-contracts Epoch decoder (drift guard)', () => {
  it('decodes the full-size 9,408-byte Epoch account (failure_counts = [u16; 3000])', () => {
    expect(getEpochDecoder().fixedSize).to.equal(9408);
  });
});
