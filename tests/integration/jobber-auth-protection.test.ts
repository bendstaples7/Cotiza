/**
 * Shared Jobber connection: login required to change it, and the OAuth
 * callback only accepts a one-time state tied to the person who started it.
 *
 * The in-memory database below implements the D1 statements this route uses,
 * including the user check, 15-minute expiry, and one-time state consume.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import jobberAuth from '../../worker/src/routes/jobber-auth.js';
import { errorHandler } from '../../worker/src/middleware/error-handler.js';
import { canManageSharedJobberConnection } from '../../worker/src/services/jobber-connection-policy.js';
import { installFetchMock, type FetchMock } from '../helpers/fetch-mock.js';

const mocks = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    email: string;
    name: string;
    createdAt: Date;
    lastActiveAt: Date;
  },
}));

vi.mock('../../worker/src/services/auth-service.js', () => ({
  AuthService: class {
    async verifySession() {
      return mocks.user;
    }
  },
}));

type UserRow = { id: string; email: string; name: string };
type OAuthStateRow = { id: string; user_id: string; created_at: Date };
type TokenRow = { access_token: string; refresh_token: string };
type WebSessionRow = { cookies: string; expires_at: string };

class MemoryJobberDb {
  private users: UserRow[] = [
    { id: 'user-manager', email: 'owner@chicago-reno.com', name: 'Owner' },
    { id: 'system', email: 'system@internal', name: 'System' },
    { id: 'outsider', email: 'outsider@example.com', name: 'Outsider' },
  ];
  private states: OAuthStateRow[] = [];
  private tokens: TokenRow | null = null;
  private webSession: WebSessionRow | null = null;

  prepare(sql: string) {
    let args: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        args = bound;
        return statement;
      },
      first: async <T = unknown>() => this.first<T>(sql, args),
      run: async () => {
        this.run(sql, args);
        return { success: true, meta: {} };
      },
      all: async <T = unknown>() => ({ results: this.all<T>(sql) }),
    };
    return statement;
  }

  insertOAuthState(id: string, userId: string, createdAt = new Date()) {
    this.states.push({ id, user_id: userId, created_at: createdAt });
  }

  oauthStates() {
    return this.states
      .map(({ id, user_id }) => ({ id, user_id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  tokenRow() {
    return this.tokens;
  }

  webSessionRow() {
    return this.webSession;
  }

  private first<T>(sql: string, args: unknown[]): T | null {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('delete from oauth_states')) {
      return this.consumeOAuthState(String(args[0])) as T | null;
    }
    if (normalized.includes('select access_token, refresh_token from jobber_tokens')) {
      return this.tokens as T | null;
    }
    if (normalized.includes('select expires_at from jobber_web_session')) {
      return (this.webSession ? { expires_at: this.webSession.expires_at } : null) as T | null;
    }
    if (normalized.includes('select cookies, expires_at from jobber_web_session')) {
      return this.webSession as T | null;
    }
    throw new Error(`Unexpected first() SQL in test DB: ${sql}`);
  }

  private run(sql: string, args: unknown[]) {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('insert into oauth_states')) {
      this.insertOAuthState(String(args[0]), String(args[1]));
      return;
    }
    if (normalized.startsWith('insert into jobber_tokens')) {
      this.tokens = { access_token: String(args[0]), refresh_token: String(args[1]) };
      return;
    }
    if (normalized.startsWith('insert into jobber_web_session')) {
      this.webSession = { cookies: String(args[0]), expires_at: String(args[1]) };
      return;
    }
    if (normalized.startsWith('delete from jobber_web_session')) {
      this.webSession = null;
      return;
    }
    throw new Error(`Unexpected run() SQL in test DB: ${sql}`);
  }

  private all<T>(sql: string): T[] {
    const normalized = normalizeSql(sql);
    if (normalized.includes('select expires_at from jobber_web_session')) {
      return (this.webSession ? [{ expires_at: this.webSession.expires_at }] : []) as T[];
    }
    if (normalized.includes('select cookies, expires_at from jobber_web_session')) {
      return (this.webSession ? [this.webSession] : []) as T[];
    }
    throw new Error(`Unexpected all() SQL in test DB: ${sql}`);
  }

  private consumeOAuthState(id: string) {
    const index = this.states.findIndex((state) => state.id === id);
    if (index === -1) return null;

    const state = this.states[index];
    const user = this.users.find((candidate) => candidate.id === state.user_id);
    const createdAtMs = state.created_at.getTime();
    const validUntilMs = Date.now() - 15 * 60 * 1000;
    const canConsume = createdAtMs > validUntilMs
      && user?.id !== 'system'
      && user?.email.toLowerCase().endsWith('@chicago-reno.com');

    if (!canConsume) return null;
    this.states.splice(index, 1);
    return { id };
  }
}

function normalizeSql(sql: string) {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim();
}

function createDb() {
  return new MemoryJobberDb();
}

type TestDb = ReturnType<typeof createDb>;

const MANAGER = {
  id: 'user-manager',
  email: 'owner@chicago-reno.com',
  name: 'Owner',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  lastActiveAt: new Date('2026-01-01T00:00:00Z'),
};

function app() {
  const hono = new Hono();
  hono.onError(errorHandler);
  hono.route('/', jobberAuth);
  return hono;
}

function envFor(db: TestDb) {
  return {
    DB: db,
    JOBBER_CLIENT_ID: 'test-client',
    JOBBER_CLIENT_SECRET: 'test-secret',
    FRONTEND_URL: 'https://cotiza-e4h.pages.dev',
    GITHUB_PAT: 'ghp_test',
  } as never;
}

function states(db: TestDb) {
  return db.oauthStates();
}

describe('shared Jobber connection policy', () => {
  it('allows signed-in Chicago Reno people and nobody else', () => {
    expect(canManageSharedJobberConnection({ id: 'u1', email: 'A@Chicago-Reno.com' })).toBe(true);
    expect(canManageSharedJobberConnection({ id: 'system', email: 'system@internal' })).toBe(false);
    expect(canManageSharedJobberConnection({ id: 'u2', email: 'outsider@example.com' })).toBe(false);
    expect(canManageSharedJobberConnection({ id: '', email: 'a@chicago-reno.com' })).toBe(false);
  });
});

describe('Jobber connection management auth', () => {
  let fetchMock: FetchMock | null = null;
  let db: TestDb;

  beforeEach(() => {
    mocks.user = { ...MANAGER };
    db = createDb();
  });

  afterEach(() => {
    fetchMock?.restore();
    fetchMock = null;
  });

  function authed(headers: Record<string, string> = {}) {
    return { Authorization: 'Bearer test-session', ...headers };
  }

  it('blocks unsigned callers from starting auth, replacing cookies, refreshing, and reading cookie status', async () => {
    const hono = app();
    const env = envFor(db);
    const routes: Array<[string, RequestInit]> = [
      ['/authorize', {}],
      ['/trigger-cookie-refresh', { method: 'POST' }],
      ['/set-cookies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookies: 'a=b' }) }],
      ['/session-cookies/status', {}],
    ];
    for (const [path, init] of routes) {
      const res = await hono.request(path, init, env);
      expect(res.status, path).toBe(401);
    }
    expect(states(db)).toHaveLength(0);
    expect(db.webSessionRow()).toBeNull();
  });

  it('blocks a signed-in person who is not on the Chicago Reno account', async () => {
    mocks.user = { ...MANAGER, id: 'outsider', email: 'outsider@example.com' };
    const res = await app().request('/authorize', { headers: authed({ Accept: 'application/json' }) }, envFor(db));
    expect(res.status).toBe(403);
    expect(states(db)).toHaveLength(0);
  });

  it('lets a manager start authorization and finish it once', async () => {
    fetchMock = installFetchMock().on('api.getjobber.com/api/oauth/token', {
      json: { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'bearer', expires_in: 3600 },
    });

    const start = await app().request('/authorize', {
      headers: authed({ Accept: 'application/json' }),
    }, envFor(db));
    expect(start.status).toBe(200);
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    const state = new URL(authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    expect(authorizationUrl).not.toContain('test-session');
    expect(states(db)).toEqual([{ id: state, user_id: MANAGER.id }]);

    const done = await app().request(`/callback?code=auth-code&state=${state}`, {}, envFor(db));
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('https://cotiza-e4h.pages.dev/social/dashboard');
    const saved = db.tokenRow();
    expect(saved).toEqual({ access_token: 'access-1', refresh_token: 'refresh-1' });
    expect(states(db)).toHaveLength(0);

    const again = await app().request(`/callback?code=auth-code&state=${state}`, {}, envFor(db));
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toContain('oauth_error=');
    expect(again.headers.get('location')).toContain('Invalid%20OAuth%20state');
    expect(fetchMock.callsTo('api.getjobber.com')).toHaveLength(1);
  });

  it('rejects a missing, expired, forged, or unbound OAuth state', async () => {
    fetchMock = installFetchMock().on('api.getjobber.com', {
      json: { access_token: 'nope', refresh_token: 'nope', token_type: 'bearer', expires_in: 1 },
    });
    const env = envFor(db);

    const missing = await app().request('/callback?code=auth-code', {}, env);
    expect(missing.headers.get('location')).toContain('Invalid%20OAuth%20state');

    db.insertOAuthState('expired-state', MANAGER.id, new Date(Date.now() - 16 * 60 * 1000));
    const expired = await app().request('/callback?code=auth-code&state=expired-state', {}, env);
    expect(expired.headers.get('location')).toContain('Invalid%20OAuth%20state');
    expect(states(db).map((row) => row.id)).toContain('expired-state');

    const forged = await app().request('/callback?code=auth-code&state=nonce.1700000000.signed', {}, env);
    expect(forged.headers.get('location')).toContain('Invalid%20OAuth%20state');

    db.insertOAuthState('system-state', 'system');
    const systemState = await app().request('/callback?code=auth-code&state=system-state', {}, env);
    expect(systemState.headers.get('location')).toContain('Invalid%20OAuth%20state');
    expect(states(db).map((row) => row.id)).toContain('system-state');

    expect(fetchMock.callsTo('api.getjobber.com')).toHaveLength(0);
    expect(db.tokenRow()).toBeNull();
  });

  it('lets a manager replace cookies with the session header, not a URL token', async () => {
    const res = await app().request('/set-cookies', {
      method: 'POST',
      headers: authed({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ cookies: 'jobber=fresh' }),
    }, envFor(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true });
    const row = db.webSessionRow();
    expect(row?.cookies).toBe('jobber=fresh');
  });
});
