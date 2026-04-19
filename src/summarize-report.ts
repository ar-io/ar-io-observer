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
import fs from 'node:fs';
import path from 'node:path';

import { ObserverReport } from './types.js';

const REPORTS_DIR = './data/reports';
const UNKNOWN_RELEASE = '(unknown)';

function resolveReportPath(arg: string | undefined): string {
  if (arg !== undefined && arg !== '') {
    return arg;
  }
  if (!fs.existsSync(REPORTS_DIR)) {
    throw new Error(
      `No report path given and default directory ${REPORTS_DIR} does not exist`,
    );
  }
  const entries = fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      name: f,
      // Filenames are epoch start heights — sort numerically, fall back to name.
      key: Number.parseInt(path.basename(f, '.json'), 10),
    }))
    .sort((a, b) => {
      if (Number.isNaN(a.key) || Number.isNaN(b.key)) {
        return a.name.localeCompare(b.name);
      }
      return b.key - a.key;
    });
  if (entries.length === 0) {
    throw new Error(`No report files found in ${REPORTS_DIR}`);
  }
  return path.join(REPORTS_DIR, entries[0].name);
}

function loadReport(filePath: string): ObserverReport {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as ObserverReport;
}

interface ReleaseBucket {
  total: number;
  passed: number;
  ownershipFailures: number;
  arnsFailures: number;
  offsetFailures: number;
  gateways: {
    host: string;
    pass: boolean;
    ownershipPass: boolean;
    arnsPass: boolean;
    offsetPass: boolean | null;
  }[];
}

function summarize(report: ObserverReport) {
  const buckets = new Map<string, ReleaseBucket>();
  const overall = {
    total: 0,
    passed: 0,
    ownershipFailures: 0,
    arnsFailures: 0,
    offsetFailures: 0,
  };

  for (const [host, a] of Object.entries(report.gatewayAssessments)) {
    const release = a.ownershipAssessment.observedRelease ?? UNKNOWN_RELEASE;
    let bucket = buckets.get(release);
    if (bucket === undefined) {
      bucket = {
        total: 0,
        passed: 0,
        ownershipFailures: 0,
        arnsFailures: 0,
        offsetFailures: 0,
        gateways: [],
      };
      buckets.set(release, bucket);
    }

    const ownershipPass = a.ownershipAssessment.pass;
    const arnsPass = a.arnsAssessments.pass;
    const offsetPass =
      a.offsetAssessments === undefined ? null : a.offsetAssessments.pass;

    bucket.total += 1;
    overall.total += 1;
    if (a.pass) {
      bucket.passed += 1;
      overall.passed += 1;
    }
    if (!ownershipPass) {
      bucket.ownershipFailures += 1;
      overall.ownershipFailures += 1;
    }
    if (!arnsPass) {
      bucket.arnsFailures += 1;
      overall.arnsFailures += 1;
    }
    if (offsetPass === false) {
      bucket.offsetFailures += 1;
      overall.offsetFailures += 1;
    }

    bucket.gateways.push({
      host,
      pass: a.pass,
      ownershipPass,
      arnsPass,
      offsetPass,
    });
  }

  return { buckets, overall };
}

function pct(n: number, d: number): string {
  if (d === 0) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function sortReleases(keys: string[]): string[] {
  return keys.sort((a, b) => {
    if (a === UNKNOWN_RELEASE) return 1;
    if (b === UNKNOWN_RELEASE) return -1;
    const na = Number.parseFloat(a);
    const nb = Number.parseFloat(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return nb - na;
    return a.localeCompare(b);
  });
}

function formatGatewayFlags(g: {
  ownershipPass: boolean;
  arnsPass: boolean;
  offsetPass: boolean | null;
}): string {
  const parts: string[] = [];
  if (!g.ownershipPass) parts.push('ownership');
  if (!g.arnsPass) parts.push('arns');
  if (g.offsetPass === false) parts.push('offset');
  return parts.length === 0 ? 'ok' : `fail: ${parts.join(', ')}`;
}

function main(): void {
  const reportPath = resolveReportPath(process.argv[2]);
  const report = loadReport(reportPath);
  const { buckets, overall } = summarize(report);

  console.log(`Report: ${reportPath}`);
  console.log(
    `Epoch ${report.epochIndex} (startHeight=${report.epochStartHeight})`,
  );
  console.log(
    `Overall: ${overall.passed}/${overall.total} passed (${pct(
      overall.passed,
      overall.total,
    )})`,
  );
  console.log(
    `  failures: ownership=${overall.ownershipFailures} arns=${overall.arnsFailures} offset=${overall.offsetFailures}`,
  );
  console.log('');
  console.log('By release:');

  const releases = sortReleases([...buckets.keys()]);
  for (const release of releases) {
    const b = buckets.get(release)!;
    console.log(
      `  release=${release}  ${b.passed}/${b.total} passed (${pct(
        b.passed,
        b.total,
      )})  ownership=${b.ownershipFailures} arns=${b.arnsFailures} offset=${b.offsetFailures}`,
    );
    const failed = b.gateways.filter((g) => !g.pass);
    if (failed.length > 0) {
      for (const g of failed) {
        console.log(`    - ${g.host}  ${formatGatewayFlags(g)}`);
      }
    }
  }
}

main();
