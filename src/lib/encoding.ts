/**
 * AR.IO Observer
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Decode a base64url-encoded string to a Buffer.
 */
export function fromB64Url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/**
 * Encode a Buffer to a base64url string.
 */
export function toB64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}
