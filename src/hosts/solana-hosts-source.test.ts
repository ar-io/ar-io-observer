/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as winston from 'winston';

import type { SolanaARIOReadable } from '@ar.io/sdk';
import { SolanaHostsSource } from './solana-hosts-source.js';

function makeLog(): winston.Logger {
  const noop = sinon.stub();
  return {
    child: () => ({
      verbose: noop,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    }),
    verbose: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as any;
}

function makeReadable(items: any[]): SolanaARIOReadable {
  return {
    getGateways: sinon.stub().resolves({ items, hasMore: false }),
  } as any;
}

describe('SolanaHostsSource', () => {
  it('maps SDK Gateway records to GatewayHost shape', async () => {
    const readable = makeReadable([
      {
        gatewayAddress: 'OPERATOR_A',
        settings: {
          fqdn: 'gateway-a.example.com',
          port: 443,
          protocol: 'https',
        },
      },
      {
        gatewayAddress: 'OPERATOR_B',
        settings: {
          fqdn: 'gateway-b.example.com',
          port: 443,
          protocol: 'https',
        },
      },
    ]);
    const src = new SolanaHostsSource({ readable, log: makeLog() });
    const hosts = await src.getHosts();
    expect(hosts).to.have.length(2);
    expect(hosts[0]).to.deep.equal({
      fqdn: 'gateway-a.example.com',
      port: 443,
      protocol: 'https',
      wallet: 'OPERATOR_A',
    });
  });

  it('skips gateways with empty fqdn (defensive)', async () => {
    const readable = makeReadable([
      {
        gatewayAddress: 'OPERATOR_GOOD',
        settings: { fqdn: 'real.example.com', port: 443, protocol: 'https' },
      },
      {
        gatewayAddress: 'OPERATOR_BAD',
        settings: { fqdn: '', port: 443, protocol: 'https' },
      },
      {
        gatewayAddress: 'OPERATOR_BAD2',
        settings: { fqdn: undefined as any, port: 443, protocol: 'https' },
      },
    ]);
    const src = new SolanaHostsSource({ readable, log: makeLog() });
    const hosts = await src.getHosts();
    expect(hosts).to.have.length(1);
    expect(hosts[0].wallet).to.equal('OPERATOR_GOOD');
  });

  it('returns an empty list when the registry is empty', async () => {
    const readable = makeReadable([]);
    const src = new SolanaHostsSource({ readable, log: makeLog() });
    const hosts = await src.getHosts();
    expect(hosts).to.deep.equal([]);
  });

  it('passes the configured limit to the SDK', async () => {
    const stub = sinon.stub().resolves({ items: [], hasMore: false });
    const readable = { getGateways: stub } as any;
    const src = new SolanaHostsSource({
      readable,
      log: makeLog(),
      limit: 50,
    });
    await src.getHosts();
    expect(stub.firstCall.args[0]).to.deep.equal({ limit: 50 });
  });

  it('defaults to limit 3000 (mainnet registry capacity)', async () => {
    const stub = sinon.stub().resolves({ items: [], hasMore: false });
    const readable = { getGateways: stub } as any;
    const src = new SolanaHostsSource({ readable, log: makeLog() });
    await src.getHosts();
    expect(stub.firstCall.args[0]).to.deep.equal({ limit: 3000 });
  });
});
