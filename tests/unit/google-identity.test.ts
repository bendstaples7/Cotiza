import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
const keys = vi.hoisted(() => ({ resolver: undefined as unknown }));
vi.mock('jose', async (original) => ({ ...await original<typeof import('jose')>(), createRemoteJWKSet: () => (...args: unknown[]) => (keys.resolver as (...args: unknown[]) => unknown)(...args) }));
import { verifyGoogleIdentity } from '../../worker/src/services/google-identity.js';
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey;
  keys.resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256' }] });
});
async function token(changes = {}) {
  return new SignJWT({ email: 'office@chicago-reno.com', email_verified: true, hd: 'chicago-reno.com', nonce: 'nonce', iss: 'https://accounts.google.com', aud: 'client', sub: 'google-user', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, ...changes })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
}
describe('verified Google identity', () => {
  it('accepts a signed Workspace identity and consumes its challenge', async () => {
    const db = createMockD1(); configurePrepareResults(db, [{ first: { nonce: 'nonce' } }]);
    expect(await verifyGoogleIdentity(db as never, await token(), 'nonce', 'client')).toEqual({ email: 'office@chicago-reno.com', subject: 'google-user' });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM google_signin_challenges'));
  });
  it.each([{ email_verified: false }, { hd: 'other.com' }, { email: 'someone@gmail.com' }, { nonce: 'wrong' }, { aud: 'other' }, { iss: 'https://attacker.invalid' }, { exp: 1 }, { azp: 'other' }])('rejects invalid identity claims %j', async (changes) => {
    const db = createMockD1();
    await expect(verifyGoogleIdentity(db as never, await token(changes), 'nonce', 'client')).rejects.toThrow();
    expect(db.prepare).not.toHaveBeenCalled();
  });
  it('rejects a tampered signature', async () => {
    const signed = await token();
    const parts = signed.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    await expect(verifyGoogleIdentity(createMockD1() as never, parts.join('.'), 'nonce', 'client')).rejects.toThrow();
  });
  it('rejects consumed challenges', async () => {
    const db = createMockD1(); configurePrepareResults(db, [{ first: null }]);
    await expect(verifyGoogleIdentity(db as never, await token(), 'nonce', 'client')).rejects.toThrow('expired or already used');
  });
  it('rejects email-only authentication and missing configuration', async () => {
    await expect(verifyGoogleIdentity({} as never, 'office@chicago-reno.com')).rejects.toThrow();
  });
});
