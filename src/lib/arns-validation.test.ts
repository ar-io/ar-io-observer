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
import { expect } from 'chai';

import { ArnsResolution } from '../types.js';
import {
  compareArnsResolutions,
  isSubdomainLabel,
  mediaType,
} from './arns-validation.js';

function resolution(overrides: Partial<ArnsResolution> = {}): ArnsResolution {
  return {
    statusCode: 200,
    resolvedId: 'id',
    ttlSeconds: '3600',
    contentType: 'application/json',
    contentLength: '10',
    dataHashDigest: 'hash',
    timings: null,
    ...overrides,
  };
}

describe('isSubdomainLabel', () => {
  it('accepts ArNS names a gateway can serve', () => {
    for (const name of ['ardrive', 'back-off', 'under_name', 'a1', 'x']) {
      expect(isSubdomainLabel(name), name).to.be.true;
    }
  });

  it('rejects names no subdomain label can carry', () => {
    for (const name of [
      '1.21212E+14',
      'Ardrive',
      'a.b',
      'a+b',
      '',
      'a'.repeat(64),
    ]) {
      expect(isSubdomainLabel(name), name).to.be.false;
    }
  });
});

describe('mediaType', () => {
  it('drops parameters and case', () => {
    expect(mediaType('application/json; charset=utf-8')).to.equal(
      'application/json',
    );
    expect(mediaType('Text/HTML;charset=UTF-8')).to.equal('text/html');
    expect(mediaType('image/png')).to.equal('image/png');
  });

  it('keeps a missing content type missing', () => {
    expect(mediaType(null)).to.be.null;
  });
});

describe('compareArnsResolutions', () => {
  it('matches resolutions that differ only in content type parameters', () => {
    expect(
      compareArnsResolutions(
        resolution({ contentType: 'application/json; charset=utf-8' }),
        resolution({ contentType: 'application/json' }),
      ),
    ).to.be.undefined;
  });

  it('reports a different media type', () => {
    expect(
      compareArnsResolutions(
        resolution({ contentType: 'text/html' }),
        resolution({ contentType: 'application/json' }),
      ),
    ).to.equal('contentType mismatch');
  });

  it('reports a content type only one side sent', () => {
    expect(
      compareArnsResolutions(resolution(), resolution({ contentType: null })),
    ).to.equal('contentType mismatch');
  });

  it('lists every mismatched property in order', () => {
    expect(
      compareArnsResolutions(
        resolution(),
        resolution({
          resolvedId: 'other',
          ttlSeconds: '60',
          contentType: 'text/plain',
          dataHashDigest: 'other',
        }),
      ),
    ).to.equal(
      'resolvedId mismatch, ttlSeconds mismatch, contentType mismatch, dataHashDigest mismatch',
    );
  });
});
