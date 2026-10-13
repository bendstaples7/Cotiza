/**
 * Shared Jobber connection: login required to change it, and the OAuth
 * callback only accepts a one-time state tied to the person who started it.
 *
 * The database fixture models the D1 statements these routes issue, including
 * the state owner check, 15-minute expiry, and one-time consume.
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

type Row = Record<string, unknown>;
type OAuthStateRow = { id: string; user_id: string; created_at: number };
type MemoryStatement = {
  run: (...args: unknown[]) => { success: boolean; meta: { changes: number } };
  get: (...args: unknown[]) => Row | null;
  all: (...args: unknown[]) => Row[];
};

function createDb() {
  const users = new Map([
    ['user-manager', { id: 'user-manager', email: 'owner@chicago-reno.com', name: 'Owner' }],
    ['system', { id: 'system', email: 'system@internal', name: 'System' }],
    ['outsider', { id: 'outsider', email: 'outsider@example.com', name: 'Outsider' }],
  ]);
  const oauthStates: OAuthStateRow[] = [];
  let jobberTokens: Row | null = null;
  let webSession: Row | null = null;

  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  function runSql(sql: string, args: unknown[]): { success: boolean; meta: { changes: number } } {
    const normalized = normalize(sql);
    if (normalized.startsWith('INSERT INTO oauth_states')) {
      if (normalized.includes("'expired-state'")) {
        oauthStates.push({ id: 'expired-state', user_id: String(args[0]), created_at: Date.now() - 16 * 60 * 1000 });
      } else if (normalized.includes("'system-state'")) {
        oauthStates.push({ id: 'system-state', user_id: 'system', created_at: Date.now() });
      } else {
        oauthStates.push({ id: String(args[0]), user_id: String(args[1]), created_at: Date.now() });
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (normalized.startsWith('INSERT INTO jobber_tokens')) {
      jobberTokens = { id: 'default', access_token: String(args[0]), refresh_token: String(args[1]) };
      return { success: true, meta: { changes: 1 } };
    }
    if (normalized.startsWith('INSERT INTO jobber_web_session')) {
      webSession = { id: 'default', cookies: String(args[0]), expires_at: String(args[1]) };
      return { success: true, meta: { changes: 1 } };
    }
    if (normalized.startsWith('DELETE FROM jobber_web_session')) {
      const changes = webSession ? 1 : 0;
      webSession = null;
      return { success: true, meta: { changes } };
    }
    return { success: true, meta: { changes: 0 } };
  }

  function getSql(sql: string, args: unknown[]): Row | null {
    const normalized = normalize(sql);
    if (normalized.startsWith('DELETE FROM oauth_states')) {
      const stateId = String(args[0]);
      const index = oauthStates.findIndex((state) => state.id === stateId);
      if (index === -1) return null;
      const state = oauthStates[index];
      const user = users.get(state.user_id);
      const isFresh = state.created_at > Date.now() - 15 * 60 * 1000;
      const isManager = Boolean(user && user.id !== 'system' && user.email.toLowerCase().endsWith('@chicago-reno.com'));
      if (!isFresh || !isManager) return null;
      oauthStates.splice(index, 1);
      return { id: state.id };
    }
    if (normalized.startsWith("SELECT access_token, refresh_token FROM jobber_tokens WHERE id = 'default'")) {
      return jobberTokens
        ? { access_token: jobberTokens.access_token, refresh_token: jobberTokens.refresh_token }
        : null;
    }
    if (normalized.startsWith("SELECT cookies FROM jobber_web_session WHERE id = 'default'")) {
      return webSession ? { cookies: webSession.cookies } : null;
    }
    if (normalized.startsWith("SELECT expires_at FROM jobber_web_session WHERE id = 'default'")) {
      return webSession ? { expires_at: webSession.expires_at } : null;
    }
    if (normalized.startsWith("SELECT cookies, expires_at FROM jobber_web_session WHERE id = 'default'")) {
      return webSession ? { cookies: webSession.cookies, expires_at: webSession.expires_at } : null;
    }
    return null;
  }

  function allSql(sql: string, args: unknown[]): Row[] {
    void args;
    const normalized = normalize(sql);
    if (normalized.startsWith('SELECT id, user_id FROM oauth_states ORDER BY id')) {
      return [...oauthStates]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, user_id }) => ({ id, user_id }));
    }
    if (normalized.startsWith('SELECT id FROM jobber_tokens')) {
      return jobberTokens ? [{ id: 'default' }] : [];
    }
    if (normalized.startsWith('SELECT id FROM jobber_web_session')) {
      return webSession ? [{ id: 'default' }] : [];
    }
    return [];
  }

  const sqlite = {
    prepare(sql: string): MemoryStatement {
      return {
        run: (...args: unknown[]) => runSql(sql, args),
        get: (...args: unknown[]) => getSql(sql, args),
        all: (...args: unknown[]) => allSql(sql, args),
      };
    },
    close() { /* in-memory fixture */ },
  };

  const db = {
    sqlite,
    prepare(sql: string) {
      let args: unknown[] = [];
      const api = {
        bind(...bound: unknown[]) {
          args = bound;
          return api;
        },
        async first() {
          return getSql(sql, args);
        },
        async run() {
          return runSql(sql, args);
        },
        async all() {
          return { results: allSql(sql, args) };
        },
      };
      return api;
    },
  };
  return db;
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
  return db.sqlite.prepare('SELECT id, user_id FROM oauth_states ORDER BY id').all() as Array<{ id: string; user_id: string }>;
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
    db.sqlite.close();
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
    expect(db.sqlite.prepare('SELECT id FROM jobber_web_session').all()).toHaveLength(0);
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
    const saved = db.sqlite.prepare("SELECT access_token, refresh_token FROM jobber_tokens WHERE id = 'default'").get() as {
      access_token: string;
      refresh_token: string;
    };
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

    db.sqlite.prepare(
      "INSERT INTO oauth_states (id, user_id, created_at) VALUES ('expired-state', ?, datetime('now', '-16 minutes'))",
    ).run(MANAGER.id);
    const expired = await app().request('/callback?code=auth-code&state=expired-state', {}, env);
    expect(expired.headers.get('location')).toContain('Invalid%20OAuth%20state');
    expect(states(db).map((row) => row.id)).toContain('expired-state');

    const forged = await app().request('/callback?code=auth-code&state=nonce.1700000000.signed', {}, env);
    expect(forged.headers.get('location')).toContain('Invalid%20OAuth%20state');

    db.sqlite.prepare(
      "INSERT INTO oauth_states (id, user_id, created_at) VALUES ('system-state', 'system', datetime('now'))",
    ).run();
    const systemState = await app().request('/callback?code=auth-code&state=system-state', {}, env);
    expect(systemState.headers.get('location')).toContain('Invalid%20OAuth%20state');
    expect(states(db).map((row) => row.id)).toContain('system-state');

    expect(fetchMock.callsTo('api.getjobber.com')).toHaveLength(0);
    expect(db.sqlite.prepare('SELECT id FROM jobber_tokens').all()).toHaveLength(0);
  });

  it('lets a manager replace cookies with the session header, not a URL token', async () => {
    const res = await app().request('/set-cookies', {
      method: 'POST',
      headers: authed({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ cookies: 'jobber=fresh' }),
    }, envFor(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true });
    const row = db.sqlite.prepare("SELECT cookies FROM jobber_web_session WHERE id = 'default'").get() as { cookies: string };
    expect(row.cookies).toBe('jobber=fresh');
  });
});
