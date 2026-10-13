/**
 * Shared Jobber connection: login required to change it, and the OAuth
 * callback only accepts a one-time state tied to the person who started it.
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

type StateRow = { id: string; user_id: string; created_at: string };
type UserRow = { id: string; email: string };

function sqliteNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

function sqliteToMs(value: string): number {
  return Date.parse(value.replace(' ', 'T') + 'Z');
}

function memoryDb(users: UserRow[]) {
  const states: StateRow[] = [];
  const saved: { accessToken?: string; refreshToken?: string; cookies?: string } = {};
  const sqlLog: string[] = [];

  const db = {
    states,
    saved,
    sqlLog,
    prepare(sql: string) {
      sqlLog.push(sql);
      let binds: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          binds = args;
          return api;
        },
        async run() {
          if (sql.includes('INSERT INTO oauth_states')) {
            states.push({
              id: String(binds[0]),
              user_id: String(binds[1]),
              created_at: sqliteNow(),
            });
          }
          if (sql.includes('INSERT INTO jobber_tokens')) {
            saved.accessToken = String(binds[0]);
            saved.refreshToken = String(binds[1]);
          }
          if (sql.includes('INSERT INTO jobber_web_session')) {
            saved.cookies = String(binds[0]);
          }
          return { success: true, meta: {} };
        },
        async first() {
          if (sql.includes('DELETE FROM oauth_states')) {
            const id = String(binds[0]);
            const idx = states.findIndex((row) => {
              if (row.id !== id) return false;
              const ageSec = (Date.now() - sqliteToMs(row.created_at)) / 1000;
              if (ageSec > 15 * 60) return false;
              const user = users.find((u) => u.id === row.user_id);
              if (!user || user.id === 'system') return false;
              return user.email.toLowerCase().endsWith('@chicago-reno.com');
            });
            if (idx < 0) return null;
            const [row] = states.splice(idx, 1);
            return { id: row.id };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return api;
    },
  };
  return db;
}

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

function envFor(db: ReturnType<typeof memoryDb>) {
  return {
    DB: db,
    JOBBER_CLIENT_ID: 'test-client',
    JOBBER_CLIENT_SECRET: 'test-secret',
    FRONTEND_URL: 'https://cotiza-e4h.pages.dev',
    GITHUB_PAT: 'ghp_test',
  } as never;
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
  let db: ReturnType<typeof memoryDb>;

  beforeEach(() => {
    mocks.user = { ...MANAGER };
    db = memoryDb([
      { id: MANAGER.id, email: MANAGER.email },
      { id: 'system', email: 'system@internal' },
      { id: 'outsider', email: 'outsider@example.com' },
    ]);
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
    expect(db.states).toHaveLength(0);
    expect(db.saved.cookies).toBeUndefined();
  });

  it('blocks a signed-in person who is not on the Chicago Reno account', async () => {
    mocks.user = { ...MANAGER, id: 'outsider', email: 'outsider@example.com' };
    const res = await app().request('/authorize', { headers: authed({ Accept: 'application/json' }) }, envFor(db));
    expect(res.status).toBe(403);
    expect(db.states).toHaveLength(0);
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
    expect(db.states).toEqual([expect.objectContaining({ id: state, user_id: MANAGER.id })]);

    const done = await app().request(`/callback?code=auth-code&state=${state}`, {}, envFor(db));
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('https://cotiza-e4h.pages.dev/social/dashboard');
    expect(db.saved).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(db.states).toHaveLength(0);

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

    db.states.push({
      id: 'expired-state',
      user_id: MANAGER.id,
      created_at: sqliteNow(-16 * 60 * 1000),
    });
    const expired = await app().request('/callback?code=auth-code&state=expired-state', {}, env);
    expect(expired.headers.get('location')).toContain('Invalid%20OAuth%20state');
    expect(db.states.map((row) => row.id)).toContain('expired-state');

    const forged = await app().request('/callback?code=auth-code&state=nonce.1700000000.signed', {}, env);
    expect(forged.headers.get('location')).toContain('Invalid%20OAuth%20state');

    db.states.push({ id: 'system-state', user_id: 'system', created_at: sqliteNow() });
    const systemState = await app().request('/callback?code=auth-code&state=system-state', {}, env);
    expect(systemState.headers.get('location')).toContain('Invalid%20OAuth%20state');
    expect(db.states.map((row) => row.id)).toContain('system-state');

    expect(fetchMock.callsTo('api.getjobber.com')).toHaveLength(0);
    expect(db.saved.accessToken).toBeUndefined();
    expect(db.sqlLog.some((sql) => sql.includes('DELETE FROM oauth_states') && sql.includes('users'))).toBe(true);
  });

  it('lets a manager replace cookies with the session header, not a URL token', async () => {
    const res = await app().request('/set-cookies', {
      method: 'POST',
      headers: authed({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ cookies: 'jobber=fresh' }),
    }, envFor(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true });
    expect(db.saved.cookies).toBe('jobber=fresh');
  });
});
