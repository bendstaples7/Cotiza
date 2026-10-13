import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { JobberIntegration } from '../../worker/src/services/jobber-integration.js';
import { JobberWebhookService } from '../../worker/src/services/jobber-webhook-service.js';
import { ActivityLogService } from '../../worker/src/services/activity-log-service.js';
import jobberAuth from '../../worker/src/routes/jobber-auth.js';
import { errorHandler } from '../../worker/src/middleware/error-handler.js';
import { installFetchMock, type FetchMock } from '../helpers/fetch-mock.js';
import { formatLog, sanitizeLogText } from '../../worker/src/services/jobber-log-sanitize.mjs';

vi.mock('../../worker/src/services/auth-service.js', () => ({
  AuthService: class {
    async verifySession() {
      return {
        id: 'user-manager',
        email: 'owner@chicago-reno.com',
        name: 'Owner',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastActiveAt: new Date('2026-01-01T00:00:00Z'),
      };
    }
  },
}));

const ACCESS = 'Zk7accessTOKEN9UNIQUEprefixaaaaSFXQQ91z';
const REFRESH = 'Qm4refreshTOKEN8UNIQUEprefixbbbbSFWWW77k';
const SECRET = 'Pn3clientSECRET7UNIQUEprefixccccSFMMM55p';
const COOKIE = 'session=Hk2cookieVALUE6UNIQUEprefixddddSFPANDA33';
const CUSTOMER = 'customer-body-UNIQUE-NEEDLE-form-notes';
const GITHUB_PAT = 'ghp_UNIQUE91githubPatValue123456';
const NEW_ACCESS = 'Nk8newACCESS99UNIQUEissuedtokenSFXNEW1a';
const NEW_REFRESH = 'Rk2newREFRESH88UNIQUEissuedtokenSFNEW2b';

const FRAGMENTS = [
  ACCESS,
  ACCESS.slice(0, 15),
  ACCESS.slice(-8),
  ACCESS.slice(-5),
  REFRESH,
  REFRESH.slice(0, 15),
  REFRESH.slice(-8),
  SECRET,
  SECRET.slice(0, 15),
  SECRET.slice(-8),
  COOKIE,
  'Hk2cookieVALUE6',
  CUSTOMER,
  GITHUB_PAT,
  NEW_ACCESS,
  NEW_REFRESH,
];

function checksum(token: string): number {
  const tokenStart = token.substring(0, 5);
  const tokenEnd = token.substring(token.length - 5);
  const sum = (part: string) => part.split('').reduce((total, char) => total + char.charCodeAt(0), 0);
  return sum(tokenStart) + sum(tokenEnd);
}

function captureLogs() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(push),
    vi.spyOn(console, 'warn').mockImplementation(push),
    vi.spyOn(console, 'error').mockImplementation(push),
  ];
  return {
    lines,
    text: () => lines.join('\n'),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

function expectNoCredentials(text: string) {
  for (const fragment of FRAGMENTS) {
    expect(text, `log contained credential fragment ${fragment.slice(0, 6)}…`).not.toContain(fragment);
  }
  expect(text).not.toContain(`token_checksum=${checksum(ACCESS)}`);
  expect(text).not.toContain('token_checksum=');
}

function activityLog() {
  const service = new ActivityLogService({} as D1Database);
  vi.spyOn(service, 'log').mockResolvedValue(undefined);
  return service;
}

function integration(store?: { load: () => Promise<{ accessToken: string; refreshToken: string } | null>; save: (a: string, r: string) => Promise<void> }) {
  return new JobberIntegration(activityLog(), {
    clientId: 'jobber-client-id',
    clientSecret: SECRET,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    apiUrl: 'https://api.getjobber.com/api/graphql',
    tokenStore: store as never,
  });
}

const QUERY = `query FetchCustomerRequests {
  requests(search: "${CUSTOMER}") { id }
}`;

describe('Jobber log redaction', () => {
  let fetchMock: FetchMock | null = null;
  let logs: ReturnType<typeof captureLogs> | null = null;

  afterEach(() => {
    fetchMock?.restore();
    logs?.restore();
    fetchMock = null;
    logs = null;
  });

  it('strips known prefixes, suffixes, and opaque secrets', () => {
    const text = sanitizeLogText(
      `prefix ${ACCESS.slice(0, 15)} suffix ${ACCESS.slice(-8)} full ${ACCESS} cookie ${COOKIE}`,
      [ACCESS, COOKIE],
    );
    expect(text).not.toContain(ACCESS.slice(0, 15));
    expect(text).not.toContain(ACCESS.slice(-8));
    expect(text).not.toContain(COOKIE);
    expect(text).toContain('[redacted]');
  });

  it('keeps a short upstream error code and drops the token body', () => {
    const summary = sanitizeLogText(
      JSON.stringify({ error: 'invalid_grant', refresh_token: REFRESH, error_description: `rejected ${REFRESH}` }),
    );
    expect(summary).toContain('invalid_grant');
    expect(summary).not.toContain(REFRESH);
  });

  it('does not log token prefixes while loading stored or env tokens', async () => {
    logs = captureLogs();
    const stored = integration({
      load: async () => ({ accessToken: ACCESS, refreshToken: REFRESH }),
      save: async () => undefined,
    });
    await stored.loadPersistedTokens();

    const missing = integration({
      load: async () => null,
      save: async () => undefined,
    });
    await missing.loadPersistedTokens();

    const failed = integration({
      load: async () => { throw new Error(`d1 exploded ${ACCESS}`); },
      save: async () => undefined,
    });
    await failed.loadPersistedTokens();

    const text = logs.text();
    expectNoCredentials(text);
    expect(text).toContain('source=d1');
    expect(text).toContain('accessTokenConfigured=true');
    expect(text).toContain('refreshTokenConfigured=true');
    expect(text).toContain('fallback=none_stored');
    expect(text).toContain('fallback=load_failed');
    expect(text).not.toContain('d1 exploded');
  });

  it('logs a successful GraphQL call without the query body or token checksum', async () => {
    logs = captureLogs();
    fetchMock = installFetchMock().on('api/graphql', {
      status: 200,
      json: { data: { requests: { edges: [] } } },
    });

    await integration().graphqlRequest(QUERY, { search: CUSTOMER });

    const text = logs.text();
    expectNoCredentials(text);
    expect(text).toContain('operation=FetchCustomerRequests');
    expect(text).toContain('http=200');
    expect(text).toContain('dataKeys=requests');
  });

  it('logs a failed GraphQL call with status and a sanitized body', async () => {
    logs = captureLogs();
    fetchMock = installFetchMock().on('api/graphql', {
      status: 403,
      text: JSON.stringify({
        error: 'access_denied',
        access_token: ACCESS,
        cookie: COOKIE,
        notes: CUSTOMER,
        message: 'access denied',
      }),
    });

    await expect(integration({
      load: async () => null,
      save: async () => undefined,
    }).graphqlRequest(QUERY)).rejects.toThrow(/http=403|403/);

    const text = logs.text();
    expectNoCredentials(text);
    expect(text).toContain('operation=FetchCustomerRequests');
    expect(text).toContain('http=403');
    expect(text).toContain('access_denied');
  });

  it('logs a failed token refresh without the refresh token or client secret', async () => {
    logs = captureLogs();
    fetchMock = installFetchMock()
      .on('oauth/token', {
        status: 400,
        json: {
          error: 'invalid_grant',
          refresh_token: REFRESH,
          client_secret: SECRET,
          error_description: `rejected ${REFRESH} ${SECRET}`,
        },
      })
      .on('api/graphql', {
        status: 401,
        text: `unauthorized Bearer ${ACCESS} ${COOKIE} ${CUSTOMER}`,
      });

    await expect(integration().graphqlRequest(QUERY)).rejects.toThrow(/401/);

    const text = logs.text();
    expectNoCredentials(text);
    expect(text).toContain('http=401');
    expect(text).toContain('operation=refreshAccessToken');
    expect(text).toContain('http=400');
    expect(text).toContain('refreshSucceeded=false');
    expect(text).toContain('invalid_grant');
  });

  it('logs a successful token refresh without the new tokens', async () => {
    logs = captureLogs();
    let graphqlCalls = 0;
    fetchMock = installFetchMock()
      .on('oauth/token', {
        status: 200,
        json: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH },
      })
      .on('api/graphql', () => {
        graphqlCalls += 1;
        if (graphqlCalls === 1) {
          return { status: 401, text: `expired ${ACCESS}` };
        }
        return { status: 200, json: { data: { requests: { edges: [] } } } };
      });

    await integration().graphqlRequest(QUERY);

    const text = logs.text();
    expectNoCredentials(text);
    expect(text).toContain('refreshSucceeded=true');
    expect(text).toContain('operation=FetchCustomerRequests');
    expect(text).toContain('http=200');
  });

  it('sanitizes webhook token load and refresh logs', async () => {
    logs = captureLogs();
    fetchMock = installFetchMock()
      .on('oauth/token', {
        status: 401,
        json: { error: 'invalid_client', client_secret: SECRET, refresh_token: REFRESH },
      })
      .on('api/graphql', {
        status: 401,
        text: JSON.stringify({ message: `expired ${ACCESS}`, authorization: `Bearer ${ACCESS}` }),
      });

    const db = {
      prepare: () => ({
        bind: () => ({ run: async () => ({}) }),
      }),
    };
    const service = new JobberWebhookService(db as unknown as D1Database, activityLog(), {
      accessToken: ACCESS,
      clientSecret: SECRET,
      clientId: 'jobber-client-id',
      refreshToken: REFRESH,
      tokenStore: {
        load: async () => ({ accessToken: ACCESS, refreshToken: REFRESH }),
        save: async () => undefined,
      } as never,
    });

    await service.loadPersistedTokens();
    await service.processWebhook({
      data: {
        webHookEvent: {
          topic: 'REQUEST_CREATE',
          appId: 'app',
          accountId: 'account',
          itemId: 'request-1',
          occurredAt: '2026-01-01T00:00:00Z',
        },
      },
    });

    const text = logs.text();
    expectNoCredentials(text);
    expect(text).toContain('loadPersistedTokens source=d1');
    expect(text).toContain('accessTokenConfigured=true');
    expect(text).toContain('operation=refreshAccessToken');
    expect(text).toContain('refreshSucceeded=false');
    expect(text).toContain('invalid_client');
  });

  it('sanitizes GitHub workflow dispatch failures', async () => {
    logs = captureLogs();
    fetchMock = installFetchMock().on('api.github.com', {
      status: 401,
      json: { message: 'Bad credentials', token: GITHUB_PAT, authorization: `Bearer ${GITHUB_PAT}` },
    });

    const app = new Hono();
    app.onError(errorHandler);
    app.route('/', jobberAuth);
    const res = await app.request('/trigger-cookie-refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-session' },
    }, {
      JOBBER_CLIENT_ID: 'test-client',
      GITHUB_PAT,
    } as never);
    const body = await res.json() as { detail?: string; error?: string };

    const text = `${logs.text()}\n${JSON.stringify(body)}`;
    expectNoCredentials(text);
    expect(text).toContain('http=401');
    expect(text).toContain('operation=triggerCookieRefresh');
    expect(body.detail || body.error || '').toContain('Bad credentials');
  });

  it('sanitizes cookie-refresh script failures that echo the cookie', () => {
    const err = {
      message: 'Command failed: wrangler d1 execute',
      stderr: `near cookies='${COOKIE}' password=${SECRET}`,
    };
    const line = formatLog('[sync-cookies] WARNING: Failed to write cookies to remote D1.', err, [COOKIE, SECRET]);
    expect(line).toContain('Failed to write cookies');
    expect(line).toContain('[redacted]');
    expect(line).not.toContain(COOKIE);
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(SECRET.slice(-8));
  });
});
