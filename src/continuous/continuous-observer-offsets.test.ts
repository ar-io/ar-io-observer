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
import { generateProofs, generateTree } from 'arweave/node/lib/merkle.js';
import { expect } from 'chai';
import crypto from 'node:crypto';
import nock from 'nock';
import * as sinon from 'sinon';
import { createLogger, transports } from 'winston';

import {
  OffsetAssessor,
  classifyChunkFetchError,
} from '../assessment/offset-assessor.js';
import { createObserverGotClient } from '../observer.js';
import {
  EntropySource,
  GatewayHost,
  ReferenceGatewaySource,
} from '../types.js';
import {
  ContinuousObserver,
  OffsetObservationConfig,
} from './continuous-observer.js';
import { ObservationState } from './types.js';

const testLog = createLogger({
  level: 'error',
  transports: new transports.Console(),
});

class FixedEntropySource implements EntropySource {
  constructor(private readonly entropy: Buffer) {}

  async getEntropy(): Promise<Buffer> {
    return this.entropy;
  }
}

// One-chunk transaction at the very start of the weave, so every planned
// offset in [0, TX_SIZE) lands inside it. The proof is a real arweave-js
// Merkle proof; only the chain lookups for tx bounds are stubbed.
const TX_SIZE = 1000;
const txData = crypto.randomBytes(TX_SIZE);
let dataRoot: Uint8Array;
let validDataPath: Buffer;

const sharedEntropy = Buffer.from('shared-epoch-entropy');

const reference: ReferenceGatewaySource = {
  getArnsResolution: async () => {
    throw new Error('unused');
  },
  checkChunkAvailability: async () => ({
    host: 'reference.example.com',
    available: true,
  }),
  getChunkMetadata: async () => ({
    host: 'reference.example.com',
    metadata: null,
  }),
};

function createOffsetAssessor(): OffsetAssessor {
  const assessor = new OffsetAssessor({
    referenceGateway: reference,
    arweaveUrl: 'https://arweave.example.com',
    gotClient: createObserverGotClient('test-release'),
  });
  sinon.stub(assessor, 'getWeaveSizeAtHeight').resolves(TX_SIZE);
  sinon.stub(assessor as any, 'resolveTxBoundsForOffset').resolves({
    effectiveDataRoot: dataRoot,
    txStartOffset: 0,
    txEndOffset: TX_SIZE - 1,
  });
  return assessor;
}

function serveChunks(fqdn: string, dataPath: Buffer): void {
  nock(`https://${fqdn}`)
    .persist()
    .get(/^\/chunk\/\d+$/)
    .reply(200, {
      chunk: txData.toString('base64url'),
      data_path: dataPath.toString('base64url'),
    });
}

function createObserver({
  gateways,
  offsetAssessor,
  offsetConfig,
  compositeEntropy = Buffer.from('per-observer-random'),
}: {
  gateways: GatewayHost[];
  offsetAssessor: OffsetAssessor;
  offsetConfig: OffsetObservationConfig;
  compositeEntropy?: Buffer;
}): ContinuousObserver {
  const observer = new ContinuousObserver({
    observerAddress: 'test-observer',
    referenceGateway: reference,
    epochSource: {
      getEpochIndex: sinon.stub().resolves(1),
      getEpochStartTimestamp: sinon.stub().resolves(0),
      getEpochEndTimestamp: sinon.stub().resolves(86_400_000),
      getEpochStartHeight: sinon.stub().resolves(0),
      getEpochSettings: sinon.stub().resolves({
        epochZeroStartTimestamp: 0,
        durationMs: 86_400_000,
      }),
    } as any,
    hostsSource: { getHosts: sinon.stub().resolves(gateways) },
    prescribedNamesSource: { getNames: sinon.stub().resolves(['p1']) },
    chosenNamesSource: { getNames: sinon.stub().resolves(['c1']) },
    entropySource: new FixedEntropySource(compositeEntropy),
    stateStore: {
      load: sinon.stub().resolves(null),
      save: sinon.stub().resolves(),
      clear: sinon.stub().resolves(),
    } as any,
    persistenceSink: { saveReport: sinon.stub() } as any,
    nodeReleaseVersion: 'test-release',
    nameAssessmentConcurrency: 1,
    offsetObservation: {
      assessor: offsetAssessor,
      sharedEntropySource: new FixedEntropySource(sharedEntropy),
      heightSource: { getHeight: sinon.stub().resolves(1_500_000) },
      config: offsetConfig,
    },
    log: testLog,
  });

  // Ownership and ArNS always pass here, so `pass` reflects offsets only.
  (observer as any).assessor = {
    initializeForEpoch: sinon.stub(),
    clearEpochState: sinon.stub(),
    assessOwnership: sinon.stub().callsFake(async ({ expectedWallets }) => ({
      expectedWallets,
      observedWallet: expectedWallets[0],
      pass: true,
    })),
    assessGatewayArns: sinon.stub().resolves({
      prescribedNames: {},
      chosenNames: {},
      pass: true,
    }),
  };

  const state: ObservationState = {
    epochIndex: 1,
    epochStartTimestamp: 0,
    epochEndTimestamp: 86_400_000,
    epochStartHeight: 0,
    windowStart: 0,
    windowEnd: 86_400_000,
    pendingObservations: [],
    gatewayObservations: new Map(
      gateways.map((g) => [
        g.fqdn,
        { fqdn: g.fqdn, wallet: g.wallet, observations: [] },
      ]),
    ),
    gatewayWallets: new Map(gateways.map((g) => [g.fqdn, [g.wallet]])),
    offsetAssessmentGateways: new Set(),
    lastCycleTimestamp: 0,
    reportSubmitted: false,
    submissionDeadlineExceeded: false,
  };
  (observer as any).state = state;
  return observer;
}

/** Load names (which selects offset gateways), then observe each once. */
async function observeAll(
  observer: ContinuousObserver,
  fqdns: string[],
  times = 1,
): Promise<void> {
  const ready = await (observer as any).loadNamesAndInitializeAssessor();
  expect(ready).to.be.true;
  const state: ObservationState = (observer as any).state;
  for (let i = 0; i < times; i++) {
    for (const fqdn of fqdns) {
      const result = await (observer as any).observeGateway({
        fqdn,
        scheduledAt: Date.now(),
      });
      state.gatewayObservations.get(fqdn)!.observations.push(result);
    }
  }
}

const enforcing: OffsetObservationConfig = {
  enabled: true,
  sampleRate: 1.0,
  sampleCount: 4,
  enforcementEnabled: true,
};

describe('ContinuousObserver offset observations', function () {
  const good = { fqdn: 'good.example.com', wallet: 'wallet-good' };
  const bad = { fqdn: 'bad.example.com', wallet: 'wallet-bad' };

  before(async function () {
    const tree = await generateTree(txData);
    dataRoot = tree.id;
    validDataPath = Buffer.from(generateProofs(tree)[0].proof);
  });

  beforeEach(function () {
    nock.cleanAll();
    nock.disableNetConnect();
  });

  afterEach(function () {
    sinon.restore();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  function corrupt(proof: Buffer): Buffer {
    const copy = Buffer.from(proof);
    copy[0] ^= 0xff;
    return copy;
  }

  it('passes a gateway that serves a valid chunk proof', async function () {
    serveChunks(good.fqdn, validDataPath);
    const observer = createObserver({
      gateways: [good],
      offsetAssessor: createOffsetAssessor(),
      offsetConfig: enforcing,
    });

    await observeAll(observer, [good.fqdn]);

    const [result] = (observer as any).state.gatewayObservations.get(
      good.fqdn,
    ).observations;
    expect(result.offsetAssessments.pass).to.be.true;
    expect(result.offsetAssessments.assessments).to.have.length(1);
    expect(result.pass).to.be.true;
  });

  it('with enforcement ON, fails a gateway serving a bad proof', async function () {
    serveChunks(bad.fqdn, corrupt(validDataPath));
    const observer = createObserver({
      gateways: [bad],
      offsetAssessor: createOffsetAssessor(),
      offsetConfig: enforcing,
    });

    await observeAll(observer, [bad.fqdn], 3);

    const observations = (observer as any).state.gatewayObservations.get(
      bad.fqdn,
    ).observations;
    for (const observation of observations) {
      expect(observation.pass).to.be.false;
      expect(observation.offsetAssessments.pass).to.be.false;
      // Every planned offset was tried before giving up
      expect(observation.offsetAssessments.assessments).to.have.length(4);
      for (const sample of observation.offsetAssessments.assessments) {
        expect(sample.failureCategory).to.equal('bad_proof');
      }
    }

    const report = (observer as any).aggregateObservations();
    expect(report.gatewayAssessments[bad.fqdn].pass).to.be.false;
    expect(report.gatewayAssessments[bad.fqdn].offsetAssessments.pass).to.be
      .false;
  });

  it('with enforcement OFF, records the failure without changing pass', async function () {
    serveChunks(bad.fqdn, corrupt(validDataPath));
    const observer = createObserver({
      gateways: [bad],
      offsetAssessor: createOffsetAssessor(),
      offsetConfig: { ...enforcing, enforcementEnabled: false },
    });

    await observeAll(observer, [bad.fqdn], 3);

    const report = (observer as any).aggregateObservations();
    const assessment = report.gatewayAssessments[bad.fqdn];
    expect(assessment.pass).to.be.true;
    expect(assessment.offsetAssessments.pass).to.be.false;
    expect(
      assessment.offsetAssessments.assessments[0].failureCategory,
    ).to.equal('bad_proof');
  });

  it('with OFFSET_OBSERVATION_ENABLED=false, skips offset checks entirely', async function () {
    // No chunk endpoint is mocked: any request would fail the gateway.
    const offsetAssessor = createOffsetAssessor();
    const assessSpy = sinon.spy(offsetAssessor, 'assessSampledGateway');
    const observer = createObserver({
      gateways: [good, bad],
      offsetAssessor,
      offsetConfig: { ...enforcing, enabled: false },
    });

    await observeAll(observer, [good.fqdn, bad.fqdn], 3);

    expect((observer as any).state.offsetAssessmentGateways.size).to.equal(0);
    expect(assessSpy.called).to.be.false;
    const report = (observer as any).aggregateObservations();
    for (const fqdn of [good.fqdn, bad.fqdn]) {
      expect(report.gatewayAssessments[fqdn].pass).to.be.true;
      expect(report.gatewayAssessments[fqdn]).to.not.have.property(
        'offsetAssessments',
      );
    }
  });

  it('leaves unsampled gateways unaffected', async function () {
    const gateways = Array.from({ length: 10 }, (_, i) => ({
      fqdn: `gw${i}.example.com`,
      wallet: `wallet${i}`,
    }));
    const observer = createObserver({
      gateways,
      offsetAssessor: createOffsetAssessor(),
      offsetConfig: { ...enforcing, sampleRate: 0.2 },
    });
    // Every gateway serves bad proofs, so any gateway that is checked
    // fails under enforcement.
    for (const { fqdn } of gateways) {
      serveChunks(fqdn, corrupt(validDataPath));
    }
    await observeAll(
      observer,
      gateways.map((g) => g.fqdn),
      3,
    );

    const sampled: Set<string> = (observer as any).state
      .offsetAssessmentGateways;
    expect(sampled.size).to.equal(2);
    const report = (observer as any).aggregateObservations();
    for (const { fqdn } of gateways) {
      const assessment = report.gatewayAssessments[fqdn];
      if (sampled.has(fqdn)) {
        expect(assessment.offsetAssessments.pass).to.be.false;
        expect(assessment.pass).to.be.false;
      } else {
        expect(assessment).to.not.have.property('offsetAssessments');
        expect(assessment.pass).to.be.true;
      }
    }
  });

  it('samples the same gateways and offsets on independent observers', async function () {
    const gateways = Array.from({ length: 20 }, (_, i) => ({
      fqdn: `gw${i}.example.com`,
      wallet: `wallet${i}`,
    }));
    const config = { ...enforcing, sampleRate: 0.2 };
    // Different per-observer (composite) entropy and host order.
    const observerA = createObserver({
      gateways,
      offsetAssessor: createOffsetAssessor(),
      offsetConfig: config,
      compositeEntropy: Buffer.from('observer-a-random'),
    });
    const observerB = createObserver({
      gateways: [...gateways].reverse(),
      offsetAssessor: createOffsetAssessor(),
      offsetConfig: config,
      compositeEntropy: Buffer.from('observer-b-random'),
    });

    await (observerA as any).loadNamesAndInitializeAssessor();
    await (observerB as any).loadNamesAndInitializeAssessor();

    const sampledA = [...(observerA as any).state.offsetAssessmentGateways];
    const sampledB = [...(observerB as any).state.offsetAssessmentGateways];
    expect(sampledA).to.have.length(4);
    expect(sampledA.sort()).to.deep.equal(sampledB.sort());

    // ... and plan the same offsets for a sampled gateway.
    const target = sampledA[0];
    serveChunks(target, corrupt(validDataPath));
    const resultA = await (observerA as any).observeGateway({
      fqdn: target,
      scheduledAt: 0,
    });
    const resultB = await (observerB as any).observeGateway({
      fqdn: target,
      scheduledAt: 0,
    });
    expect(resultA.offsetAssessments.plannedOffsets).to.deep.equal(
      resultB.offsetAssessments.plannedOffsets,
    );
  });

  it('does not fail a gateway when the observer cannot set the search space', async function () {
    const offsetAssessor = createOffsetAssessor();
    (offsetAssessor.getWeaveSizeAtHeight as sinon.SinonStub).rejects(
      new Error('arweave node down'),
    );
    const observer = createObserver({
      gateways: [bad],
      offsetAssessor,
      offsetConfig: enforcing,
    });

    await observeAll(observer, [bad.fqdn]);

    const [result] = (observer as any).state.gatewayObservations.get(
      bad.fqdn,
    ).observations;
    expect(result).to.not.have.property('offsetAssessments');
    expect(result.pass).to.be.true;
  });

  describe('failure categories', function () {
    async function sampleOnce(): Promise<any> {
      const observer = createObserver({
        gateways: [bad],
        offsetAssessor: createOffsetAssessor(),
        offsetConfig: { ...enforcing, sampleCount: 1 },
      });
      await observeAll(observer, [bad.fqdn]);
      return (observer as any).state.gatewayObservations.get(bad.fqdn)
        .observations[0].offsetAssessments.assessments[0];
    }

    it('marks a 404 as http_status', async function () {
      nock(`https://${bad.fqdn}`)
        .get(/^\/chunk\/\d+$/)
        .reply(404);
      expect((await sampleOnce()).failureCategory).to.equal('http_status');
    });

    it('marks a non-JSON body as invalid_chunk', async function () {
      nock(`https://${bad.fqdn}`)
        .get(/^\/chunk\/\d+$/)
        .reply(200, '<html>not a chunk</html>');
      expect((await sampleOnce()).failureCategory).to.equal('invalid_chunk');
    });

    it('marks an observer-side chain lookup failure as unverifiable', async function () {
      serveChunks(bad.fqdn, validDataPath);
      const assessor = createOffsetAssessor();
      ((assessor as any).resolveTxBoundsForOffset as sinon.SinonStub).rejects(
        new Error('arweave node timeout'),
      );
      const observer = createObserver({
        gateways: [bad],
        offsetAssessor: assessor,
        offsetConfig: { ...enforcing, sampleCount: 1 },
      });
      await observeAll(observer, [bad.fqdn]);
      const sample = (observer as any).state.gatewayObservations.get(bad.fqdn)
        .observations[0].offsetAssessments.assessments[0];
      expect(sample.failureCategory).to.equal('unverifiable');
    });

    // Connection errors are classified directly: through got they wait
    // out retry backoff, which makes an end-to-end test slow.
    it('classifies connection errors as network', function () {
      for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EPROTO']) {
        expect(
          classifyChunkFetchError({ name: 'RequestError', code }),
        ).to.equal('network');
      }
    });

    it('classifies got timeouts as timeout', function () {
      expect(classifyChunkFetchError({ name: 'TimeoutError' })).to.equal(
        'timeout',
      );
      expect(classifyChunkFetchError({ code: 'ETIMEDOUT' })).to.equal(
        'timeout',
      );
    });
  });
});
