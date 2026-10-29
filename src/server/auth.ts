import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { isValidDocId } from '../protocol/limits.js';
import type { Role } from '../protocol/messages.js';

export interface Claims {
  /** Document the token grants access to. One token, one document. */
  doc: string;
  /** Opaque user id, surfaced to peers as the presence identity. */
  sub: string;
  role: Role;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

export type AuthResult =
  | { ok: true; claims: Claims }
  | { ok: false; reason: string };

const b64url = (buf: Uint8Array): string =>
  Buffer.from(buf).toString('base64url');

/**
 * Tokens are `base64url(json).base64url(hmac-sha256)`.
 *
 * This is a deliberately small, self-contained signer rather than a JWT
 * library: the point of the project is the CRDT transport, and a 40-line
 * signer is easier to audit than a dependency. It is not a general-purpose JWT
 * implementation and should not be used as one — in a real deployment the
 * surrounding application issues these, see README "Authorisation".
 */
export function signToken(secret: string, claims: Claims): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8');
  const sig = createHmac('sha256', secret).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

export function verifyToken(
  secret: string,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AuthResult {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: 'token is not payload.signature' };
  }
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let payload: Buffer;
  let presented: Buffer;
  try {
    payload = Buffer.from(payloadB64, 'base64url');
    presented = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, reason: 'token is not valid base64url' };
  }

  const expected = createHmac('sha256', secret).update(payload).digest();
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return { ok: false, reason: 'signature mismatch' };
  }

  let claims: Claims;
  try {
    claims = JSON.parse(payload.toString('utf8')) as Claims;
  } catch {
    return { ok: false, reason: 'payload is not JSON' };
  }

  if (typeof claims.doc !== 'string' || !isValidDocId(claims.doc)) {
    return { ok: false, reason: 'claims.doc is missing or not a valid doc id' };
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    return { ok: false, reason: 'claims.sub is missing' };
  }
  if (claims.role !== 'read' && claims.role !== 'write') {
    return { ok: false, reason: 'claims.role must be "read" or "write"' };
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: 'claims.exp is missing' };
  }
  if (claims.exp <= nowSeconds) {
    return { ok: false, reason: 'token has expired' };
  }

  return { ok: true, claims };
}

export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}
