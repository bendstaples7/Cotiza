import { createRemoteJWKSet, jwtVerify } from 'jose';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export async function newGoogleChallenge(db: D1Database): Promise<string> {
  const nonce = crypto.randomUUID();
  await db.prepare('DELETE FROM google_signin_challenges WHERE expires_at < ?').bind(Date.now()).run();
  await db.prepare('INSERT INTO google_signin_challenges (nonce, expires_at) VALUES (?, ?)').bind(nonce, Date.now() + 300000).run();
  return nonce;
}

export async function verifyGoogleIdentity(db: D1Database, credential: string, nonce?: string, clientId?: string) {
  if (!credential || credential.length > 16384 || !nonce || !clientId) throw new Error('Verified Google sign-in is required.');
  const { payload } = await jwtVerify(credential, googleKeys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId, algorithms: ['RS256'],
    requiredClaims: ['exp', 'iat', 'sub', 'nonce'], maxTokenAge: '5m',
  });
  if (payload.nonce !== nonce || payload.email_verified !== true || payload.hd !== 'chicago-reno.com'
      || typeof payload.email !== 'string' || !/^[^@\s]+@chicago-reno\.com$/i.test(payload.email)
      || (payload.azp !== undefined && payload.azp !== clientId)) throw new Error('A verified Chicago Reno Google account is required.');
  const consumed = await db.prepare('DELETE FROM google_signin_challenges WHERE nonce = ? AND expires_at > ? RETURNING nonce').bind(nonce, Date.now()).first();
  if (!consumed) throw new Error('Sign-in expired or already used. Please sign in again.');
  return { email: payload.email.toLowerCase(), subject: payload.sub! };
}
