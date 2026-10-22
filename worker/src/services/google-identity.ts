import { createRemoteJWKSet, jwtVerify, errors } from 'jose';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export class GoogleIdentityRejected extends Error {}
export class GoogleChallengeLimit extends Error {}

export function googleSignInClientId(env: { GOOGLE_SIGNIN_CLIENT_ID?: string; GMAIL_CLIENT_ID?: string }): string {
  return env.GOOGLE_SIGNIN_CLIENT_ID?.trim() || env.GMAIL_CLIENT_ID?.trim() || '';
}

export async function newGoogleChallenge(db: D1Database, source = 'unknown'): Promise<string> {
  const nonce = crypto.randomUUID();
  await db.prepare('DELETE FROM google_signin_challenges WHERE expires_at < ?').bind(Date.now()).run();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const sourceHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const inserted = await db.prepare(`INSERT INTO google_signin_challenges (nonce, expires_at, source_hash)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM google_signin_challenges) < 1000
    AND (SELECT COUNT(*) FROM google_signin_challenges WHERE source_hash = ?) < 10 RETURNING nonce`)
    .bind(nonce, Date.now() + 300000, sourceHash, sourceHash).first();
  if (!inserted) throw new GoogleChallengeLimit('Too many sign-in attempts. Try again in five minutes.');
  return nonce;
}

export async function verifyGoogleIdentity(db: D1Database, credential: string, nonce?: string, clientId?: string) {
  if (typeof credential !== 'string' || !credential || credential.length > 16384 || typeof nonce !== 'string' || !nonce || nonce.length > 128 || !clientId) throw new GoogleIdentityRejected('Verified Google sign-in is required.');
  const { payload } = await jwtVerify(credential, googleKeys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId, algorithms: ['RS256'],
    requiredClaims: ['exp', 'iat', 'sub', 'nonce'], maxTokenAge: '5m',
  }).catch((error: unknown) => {
    if (error instanceof errors.JWTClaimValidationFailed || error instanceof errors.JWTExpired
      || error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JWSInvalid
      || error instanceof errors.JWTInvalid || error instanceof errors.JOSEAlgNotAllowed
      || error instanceof errors.JWKSNoMatchingKey) throw new GoogleIdentityRejected('Google credential was rejected.');
    throw error;
  });
  if (payload.nonce !== nonce || payload.email_verified !== true || payload.hd !== 'chicago-reno.com'
      || typeof payload.email !== 'string' || !/^[^@\s]+@chicago-reno\.com$/i.test(payload.email)
      || (payload.azp !== undefined && payload.azp !== clientId)) throw new GoogleIdentityRejected('A verified Chicago Reno Google account is required.');
  const consumed = await db.prepare('DELETE FROM google_signin_challenges WHERE nonce = ? AND expires_at > ? RETURNING nonce').bind(nonce, Date.now()).first();
  if (!consumed) throw new GoogleIdentityRejected('Sign-in expired or already used. Please sign in again.');
  return { email: payload.email.toLowerCase(), subject: payload.sub! };
}
