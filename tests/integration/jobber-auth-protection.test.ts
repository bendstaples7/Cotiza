/**
 * Shared Jobber connection: login required to change it, and the OAuth
 * callback only accepts a one-time state tied to the person who started it.
 *
 * The database is real SQLite, so the route's DELETE (user check, 15-minute
 * expiry, one-time consume) actually runs.
 */
import { createRequire } from 'node:module';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
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

function createDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE oauth_states (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE jobber_tokens (
      id TEXT PRIMARY KEY DEFAULT 'default',
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE jobber_web_session (
      id TEXT PRIMARY KEY DEFAULT 'default',
      cookies TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE activity_log_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      component TEXT NOT NULL,
      operation TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      description TEXT NOT NULL,
      recommended_action TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users (id, email, name) VALUES
      ('user-manager', 'owner@chicago-reno.com', 'Owner'),
      ('system', 'system@internal', 'System'),
      ('outsider', 'outsider@example.com', 'Outsider');
  `);

  const db = {
    sqlite,
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      let args: unknown[] = [];
      const api = {
        bind(...bound: unknown[]) {
          args = bound;
          return api;
        },
        async first() {
          return stmt.get(...(args as never[])) ?? null;
        },
        async run() {
          stmt.run(...(args as never[]));
          return { success: true, meta: {} };
        },
        async all() {
          return { results: stmt.all(...(args as never[])) };
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
