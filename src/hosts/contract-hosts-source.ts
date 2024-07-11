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
import winston from 'winston';

import defaultLogger from '../log.js';
import { GatewayHost, GatewayHostsSource } from '../types.js';

export class ContractHostsSource implements GatewayHostsSource {
  private contract: AoIORead;
  private log: winston.Logger;

  constructor({
    contract,
    log = defaultLogger,
  }: {
    contract: AoIORead;
    log?: winston.Logger;
  }) {
    this.contract = contract;
    this.log = log.child({ source: 'ContractHostsSource' });
  }

  async getHosts(): Promise<GatewayHost[]> {
    const hosts = [];
    let cursor: string | undefined;
    this.log.debug('Fetching gateways to observe');
    do {
      const { nextCursor, items } = await this.contract.getGateways({
        cursor,
      }); // TODO: better error handling
      for (const gateway of items) {
        if (gateway.settings.fqdn === undefined) {
          // skip gateways without FQDN
          this.log.debug(`No FQDN found for gateway ${gateway.gatewayAddress}`);
          continue;
        }
        hosts.push({
          startTimestamp: gateway.startTimestamp,
          endTimestamp: gateway.endTimestamp,
          fqdn: gateway.settings.fqdn,
          port: gateway.settings.port,
          protocol: gateway.settings.protocol,
          wallet: gateway.gatewayAddress,
        });
      }

      cursor = nextCursor;
    } while (cursor !== undefined);

    if (Object.keys(hosts).length === 0) {
      throw new Error('No gateways found');
    }

    this.log.debug(`Found ${hosts.length} gateways to observe`);
    return hosts;
  }
}
