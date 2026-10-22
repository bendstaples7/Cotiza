const SCOPE = 'ops:read';
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

export const ASSISTANT_SCOPE = SCOPE;

export const BUILTIN_OAUTH_CLIENTS: Record<string, { name: string; redirectUris: string[] }> = {
  'cotiza-ops-local': {
    name: 'Cotiza local exercise',
    redirectUris: [
      'http://127.0.0.1:8787/oauth/exercise-callback',
      'http://localhost:8787/oauth/exercise-callback',
    ],
  },
};

export interface AssistantPrincipal {
  tokenId: string;
  userId: string;
  clientId: string;
  resource: string;
  scope: typeof SCOPE;
}

export interface IssuedToken {
  id: string;
  token: string;
  expiresAt: string;
}

export interface OauthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
}

export interface AuthCodeRecord {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: string;
}

export interface AssistantDirectory {
  authenticateAccessToken(token: string, resource: string, now?: Date): Promise<AssistantPrincipal | null>;
  authenticateRefreshToken(token: string, resource: string, now?: Date): Promise<AssistantPrincipal | null>;
  mintToken(input: {
    userId: string;
    resource: string;
    label: string;
    clientId: string;
    kind: 'access' | 'refresh';
    ttlMs: number;
  }): Promise<IssuedToken>;
  revoke(userId: string, tokenId: string): Promise<boolean>;
  revokeByHash(token: string): Promise<boolean>;
  list(userId: string): Promise<Array<{ id: string; label: string; kind: string; expiresAt: string; revokedAt: string | null; createdAt: string }>>;
  findClient(clientId: string): Promise<OauthClient | null>;
  saveClient(client: OauthClient): Promise<void>;
  saveTx(id: string, payload: string, expiresAt: string): Promise<void>;
  loadTx(id: string, now?: Date): Promise<string | null>;
  saveCode(record: AuthCodeRecord & { code: string }): Promise<void>;
  /** Returns the code row once. A second call returns null. */
  consumeCode(code: string, now?: Date): Promise<AuthCodeRecord | null>;
}

export function mcpResource(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.origin}/mcp`;
}

export function redirectUriAllowed(uri: string): boolean {
  if (uri === 'https://chatgpt.com/connector_platform_oauth_redirect') return true;
  if (uri.startsWith('https://chatgpt.com/connector/oauth/') && uri.length <= 180) return true;
  if (uri === 'http://127.0.0.1:8787/oauth/exercise-callback') return true;
  if (uri === 'http://localhost:8787/oauth/exercise-callback') return true;
  return false;
}

export function oauthAuthorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

export function oauthProtectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    resource_documentation: `${origin}/oauth/exercise-callback`,
    bearer_methods_supported: ['header'],
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(digest);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}${base64Url(bytes)}`;
}

function expired(iso: string, now: Date): boolean {
  const t = Date.parse(iso);
  return Number.isNaN(t) || t <= now.getTime();
}

export class D1AssistantDirectory implements AssistantDirectory {
  constructor(private readonly db: D1Database) {}

  async authenticateAccessToken(token: string, resource: string, now = new Date()): Promise<AssistantPrincipal | null> {
    if (!token.startsWith('ctz_')) return null;
    const tokenHash = await sha256Hex(token);
    const row = await this.db.prepare(
      `SELECT id, user_id, client_id, resource, scope, kind, expires_at, revoked_at
       FROM assistant_tokens WHERE identity_verified = 1 AND token_hash = ?`,
    ).bind(tokenHash).first<{
      id: string;
      user_id: string;
      client_id: string;
      resource: string;
      scope: string;
      kind: string;
      expires_at: string;
      revoked_at: string | null;
    }>();
    if (!row || row.kind !== 'access' || row.revoked_at || row.scope !== SCOPE) return null;
    if (row.resource !== resource || expired(row.expires_at, now)) return null;
    return { tokenId: row.id, userId: row.user_id, clientId: row.client_id, resource: row.resource, scope: SCOPE };
  }

  async authenticateRefreshToken(token: string, resource: string, now = new Date()): Promise<AssistantPrincipal | null> {
    if (!token.startsWith('ctz_')) return null;
    const tokenHash = await sha256Hex(token);
    const row = await this.db.prepare(
      `SELECT id, user_id, client_id, resource, scope, kind, expires_at, revoked_at
       FROM assistant_tokens WHERE identity_verified = 1 AND token_hash = ?`,
    ).bind(tokenHash).first<{
      id: string;
      user_id: string;
      client_id: string;
      resource: string;
      scope: string;
      kind: string;
      expires_at: string;
      revoked_at: string | null;
    }>();
    if (!row || row.kind !== 'refresh' || row.revoked_at || row.scope !== SCOPE) return null;
    if (row.resource !== resource || expired(row.expires_at, now)) return null;
    return { tokenId: row.id, userId: row.user_id, clientId: row.client_id, resource: row.resource, scope: SCOPE };
  }

  async mintToken(input: {
    userId: string;
    resource: string;
    label: string;
    clientId: string;
    kind: 'access' | 'refresh';
    ttlMs: number;
  }): Promise<IssuedToken> {
    const id = crypto.randomUUID();
    const token = randomToken('ctz_');
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    await this.db.prepare(
      `INSERT INTO assistant_tokens
        (id, token_hash, kind, user_id, client_id, label, resource, scope, expires_at, identity_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).bind(id, tokenHash, input.kind, input.userId, input.clientId, input.label.slice(0, 80), input.resource, SCOPE, expiresAt).run();
    return { id, token, expiresAt };
  }

  async revoke(userId: string, tokenId: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE assistant_tokens SET revoked_at = datetime('now')
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    ).bind(tokenId, userId).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async revokeByHash(token: string): Promise<boolean> {
    if (!token.startsWith('ctz_')) return false;
    const tokenHash = await sha256Hex(token);
    const result = await this.db.prepare(
      `UPDATE assistant_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL`,
    ).bind(tokenHash).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async list(userId: string) {
    const result = await this.db.prepare(
      `SELECT id, label, kind, expires_at, revoked_at, created_at
       FROM assistant_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(userId).all<{ id: string; label: string; kind: string; expires_at: string; revoked_at: string | null; created_at: string }>();
    return (result.results ?? []).map((row) => ({
      id: row.id,
      label: row.label,
      kind: row.kind,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    }));
  }

  async findClient(clientId: string): Promise<OauthClient | null> {
    const builtin = BUILTIN_OAUTH_CLIENTS[clientId];
    if (builtin) return { clientId, name: builtin.name, redirectUris: builtin.redirectUris };
    const row = await this.db.prepare(
      `SELECT client_id, client_name, redirect_uris FROM assistant_oauth_clients WHERE client_id = ?`,
    ).bind(clientId).first<{ client_id: string; client_name: string; redirect_uris: string }>();
    if (!row) return null;
    const redirectUris = JSON.parse(row.redirect_uris) as string[];
    return { clientId: row.client_id, name: row.client_name, redirectUris };
  }

  async saveClient(client: OauthClient): Promise<void> {
    await this.db.prepare(
      `INSERT INTO assistant_oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         client_name = excluded.client_name,
         redirect_uris = excluded.redirect_uris`,
    ).bind(client.clientId, client.name.slice(0, 80), JSON.stringify(client.redirectUris)).run();
  }

  async saveTx(id: string, payload: string, expiresAt: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO verified_assistant_oauth_tx (id, payload, expires_at, identity_verified) VALUES (?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at, identity_verified = 1`,
    ).bind(id, payload, expiresAt).run();
  }

  async loadTx(id: string, now = new Date()): Promise<string | null> {
    const row = await this.db.prepare(
      `SELECT payload, expires_at FROM verified_assistant_oauth_tx WHERE identity_verified = 1 AND id = ?`,
    ).bind(id).first<{ payload: string; expires_at: string }>();
    if (!row || expired(row.expires_at, now)) return null;
    return row.payload;
  }

  async saveCode(record: AuthCodeRecord & { code: string }): Promise<void> {
    const codeHash = await sha256Hex(record.code);
    await this.db.prepare(
      `INSERT INTO assistant_auth_codes
        (code_hash, user_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at, identity_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).bind(
      codeHash,
      record.userId,
      record.clientId,
      record.redirectUri,
      record.codeChallenge,
      record.resource,
      record.scope,
      record.expiresAt,
    ).run();
  }

  async consumeCode(code: string, now = new Date()): Promise<AuthCodeRecord | null> {
    const codeHash = await sha256Hex(code);
    const row = await this.db.prepare(
      `SELECT user_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at, used_at
       FROM assistant_auth_codes WHERE identity_verified = 1 AND code_hash = ?`,
    ).bind(codeHash).first<{
      user_id: string;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      resource: string;
      scope: string;
      expires_at: string;
      used_at: string | null;
    }>();
    if (!row || row.used_at || expired(row.expires_at, now) || row.scope !== SCOPE) return null;
    const updated = await this.db.prepare(
      `UPDATE assistant_auth_codes SET used_at = datetime('now') WHERE code_hash = ? AND used_at IS NULL`,
    ).bind(codeHash).run();
    if ((updated.meta?.changes ?? 0) < 1) return null;
    return {
      userId: row.user_id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      resource: row.resource,
      scope: row.scope,
      expiresAt: row.expires_at,
    };
  }
}

export const ACCESS_TOKEN_TTL_MS = ACCESS_TTL_MS;
export const REFRESH_TOKEN_TTL_MS = REFRESH_TTL_MS;
export const AUTH_CODE_TTL_MS = CODE_TTL_MS;

export class CallBudget {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
    private readonly now = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const prev = (this.hits.get(key) ?? []).filter((ts) => t - ts < this.windowMs);
    if (prev.length >= this.limit) {
      this.hits.set(key, prev);
      return false;
    }
    prev.push(t);
    this.hits.set(key, prev);
    return true;
  }
}
