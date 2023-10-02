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
import got from 'got';

import { GatewayHost, GatewayHostList } from '../types.js';

export class RemoteCacheHostList implements GatewayHostList {
  private baseCacheUrl: string;
  private contractId: string;

  constructor({
    baseCacheUrl,
    contractId,
  }: {
    baseCacheUrl: string;
    contractId: string;
  }) {
    this.baseCacheUrl = baseCacheUrl;
    this.contractId = contractId;
  }

  async getHosts(): Promise<GatewayHost[]> {
    const url = `${this.baseCacheUrl}/v1/contract/${this.contractId}/gateways`;
    const resp = await got.get(url).json<any>();
    const gateways = resp?.gateways;
    if (!gateways) {
      throw new Error('No gateways found in response');
    }
    const hosts = [];
    for (const [wallet, gateway] of Object.entries(gateways) as any) {
      if (gateway?.settings?.fqdn === undefined) {
        throw new Error('No FQDN found');
      } else {
        hosts.push({
          fqdn: gateway?.settings?.fqdn,
          port: gateway?.settings?.port,
          protocol: gateway?.settings?.protocol,
          wallet: wallet,
        });
      }
    }
    return hosts;
  }
}
