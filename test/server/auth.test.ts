import { describe, expect, it } from 'vitest';
import { generateSecret, signToken, verifyToken } from '../../src/server/auth.js';

const SECRET = 'test-secret';
const future = Math.floor(Date.now() / 1000) + 600;

describe('access tokens', () => {
  it('verifies a token it signed', () => {
    const token = signToken(SECRET, {
      doc: 'demo',
      sub: 'alice',
      role: 'write',
      exp: future,
    });
    const result = verifyToken(SECRET, token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).toEqual({
        doc: 'demo',
        sub: 'alice',
        role: 'write',
        exp: future,
      });
    }
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken(generateSecret(), {
      doc: 'demo',
      sub: 'alice',
      role: 'write',
      exp: future,
    });
    const result = verifyToken(SECRET, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature mismatch');
  });

  it('rejects a token whose claims were edited after signing', () => {
    const token = signToken(SECRET, {
      doc: 'demo',
      sub: 'alice',
      role: 'read',
      exp: future,
    });
    const [payload, signature] = token.split('.') as [string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // The classic escalation attempt: keep the signature, raise the role.
    claims.role = 'write';
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;

    const result = verifyToken(SECRET, forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature mismatch');
  });

  it('rejects an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    const token = signToken(SECRET, {
      doc: 'demo',
      sub: 'alice',
      role: 'write',
      exp: past,
    });
    const result = verifyToken(SECRET, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token has expired');
  });

  it('rejects a token whose doc claim could escape the data directory', () => {
    const token = signToken(SECRET, {
      doc: '../../etc/passwd',
      sub: 'alice',
      role: 'write',
      exp: future,
    });
    const result = verifyToken(SECRET, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a valid doc id/);
  });

  it('rejects malformed shapes without throwing', () => {
    for (const token of ['', '.', 'nodot', 'a.', '.b', 'a.b', '!!!.???']) {
      const result = verifyToken(SECRET, token);
      expect(result.ok, JSON.stringify(token)).toBe(false);
    }
  });

  it('rejects a validly signed token with an unknown role', () => {
    const token = signToken(SECRET, {
      doc: 'demo',
      sub: 'alice',
      role: 'admin' as unknown as 'write',
      exp: future,
    });
    const result = verifyToken(SECRET, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/role/);
  });
});
