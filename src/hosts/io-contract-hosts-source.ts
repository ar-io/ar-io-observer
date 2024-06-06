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
import { AoIORead } from '@ar.io/sdk';

import { GatewayHost, GatewayHostsSource } from '../types.js';

export class ContractHostsSource implements GatewayHostsSource {
  private contract: AoIORead;

  constructor({ contract }: { contract: AoIORead }) {
    this.contract = contract;
  }

  async getHosts(): Promise<GatewayHost[]> {
    const gateways = await this.contract.getGateways();
    if (Object.keys(gateways).length === 0) {
      throw new Error('No gateways found in response');
    }
    const hosts = [];
    for (const [wallet, gateway] of Object.entries(gateways) as any) {
      if (gateway?.settings?.fqdn === undefined) {
        throw new Error('No FQDN found');
      } else {
        hosts.push({
          start: gateway?.start,
          end: gateway?.end,
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
