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
import * as config from './config.js';
import log from './log.js';
import { app } from './server.js';
import { createContinuousObserver } from './system.js';

if (config.RUN_OBSERVER) {
  const continuousObserver = createContinuousObserver();

  // Start the continuous observer (its own internal try/catch keeps
  // per-cycle errors from propagating). If `start()` itself ever
  // rejects, that's from a one-shot initialization step like
  // `initializeOrRestore()` — most commonly a transient epoch read
  // during a fast-epoch boundary. We auto-restart with bounded
  // exponential backoff so an operator doesn't need to babysit
  // every transient.
  const MAX_RESTART_ATTEMPTS = 12;
  const BACKOFF_BASE_MS = 5_000;
  const startSupervisor = async (attempt: number): Promise<void> => {
    try {
      await continuousObserver.start();
      // start() resolves only when stop() was called — clean exit.
      log.info('Continuous observer exited cleanly');
    } catch (error: any) {
      log.error(
        'Continuous observer start() rejected — attempting auto-restart',
        {
          attempt,
          maxAttempts: MAX_RESTART_ATTEMPTS,
          error: error.message,
          stack: error.stack,
        },
      );
      if (attempt >= MAX_RESTART_ATTEMPTS) {
        log.error(
          'Continuous observer exhausted restart budget — exiting (operator must investigate)',
        );
        process.exit(1);
      }
      const backoffMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, attempt - 1),
        5 * 60 * 1000, // cap at 5min
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      return startSupervisor(attempt + 1);
    }
  };
  void startSupervisor(1);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    log.verbose('SIGTERM received, stopping continuous observer...');
    continuousObserver.stop();
  });

  process.on('SIGINT', () => {
    log.verbose('SIGINT received, stopping continuous observer...');
    continuousObserver.stop();
  });

  app.listen(config.PORT, () => {
    log.verbose(`Listening on port ${config.PORT}`);
  });
} else {
  log.warn('Observer is disabled', {
    RUN_OBSERVER: config.RUN_OBSERVER,
  });
}
