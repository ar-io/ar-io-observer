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

  describe('leaving-gateway filtering', () => {
    // Deliberately mixes every status case, including the two that must NOT be
    // excluded: an absent status, and an unrecognised one. Without those two
    // present the fail-open behaviour would be assumed rather than exercised.
    const MIXED = [
      {
        gatewayAddress: 'JOINED',
        status: 'joined',
        settings: { fqdn: 'joined.example.com', port: 443, protocol: 'https' },
      },
      {
        gatewayAddress: 'LEAVING',
        status: 'leaving',
        settings: { fqdn: 'leaving.example.com', port: 443, protocol: 'https' },
      },
      {
        gatewayAddress: 'NO_STATUS',
        settings: {
          fqdn: 'nostatus.example.com',
          port: 443,
          protocol: 'https',
        },
      },
      {
        gatewayAddress: 'UNKNOWN_STATUS',
        status: 'someFutureStatus',
        settings: { fqdn: 'weird.example.com', port: 443, protocol: 'https' },
      },
    ];

    const walletsOf = (hosts: { wallet: string }[]) =>
      hosts.map((h) => h.wallet);

    it('excludes gateways the registry reports as leaving', async () => {
      const src = new SolanaHostsSource({
        readable: makeReadable(MIXED),
        log: makeLog(),
      });
      expect(walletsOf(await src.getHosts())).to.not.include('LEAVING');
    });

    it('keeps gateways whose status is absent or unrecognised (fail open)', async () => {
      // The guard that matters. A registry or SDK that stops reporting status
      // must degrade to observing everyone, never to observing no one -- an
      // empty host list would silently produce an empty report.
      const src = new SolanaHostsSource({
        readable: makeReadable(MIXED),
        log: makeLog(),
      });
      const got = walletsOf(await src.getHosts());
      expect(got).to.include('NO_STATUS');
      expect(got).to.include('UNKNOWN_STATUS');
      expect(got).to.include('JOINED');
      expect(got).to.have.length(3);
    });

    it('does not empty the host list when no gateway reports a status', async () => {
      const src = new SolanaHostsSource({
        readable: makeReadable([
          {
            gatewayAddress: 'A',
            settings: { fqdn: 'a.example.com', port: 443, protocol: 'https' },
          },
          {
            gatewayAddress: 'B',
            settings: { fqdn: 'b.example.com', port: 443, protocol: 'https' },
          },
        ]),
        log: makeLog(),
      });
      expect(await src.getHosts()).to.have.length(2);
    });

    it('keeps leaving gateways when skipLeaving is disabled', async () => {
      const src = new SolanaHostsSource({
        readable: makeReadable(MIXED),
        log: makeLog(),
        skipLeaving: false,
      });
      expect(walletsOf(await src.getHosts())).to.include('LEAVING');
    });

    it('still skips an empty fqdn even when the gateway is joined', async () => {
      const src = new SolanaHostsSource({
        readable: makeReadable([
          {
            gatewayAddress: 'JOINED_NO_FQDN',
            status: 'joined',
            settings: { fqdn: '', port: 443, protocol: 'https' },
          },
        ]),
        log: makeLog(),
      });
      expect(await src.getHosts()).to.deep.equal([]);
    });
  });
});
