import { describe, it, expect, afterEach } from 'vitest';
import jobberAuth from '../../worker/src/routes/jobber-auth.js';
import { installFetchMock, type FetchMock } from '../helpers/fetch-mock.js';

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    // Needed to pass the jobber-auth "not configured" guard middleware.
    JOBBER_CLIENT_ID: 'test-client',
    GITHUB_PAT: 'ghp_test',
    ...overrides,
  } as never;
}

function trigger(env: ReturnType<typeof baseEnv>) {
  return jobberAuth.request('/trigger-cookie-refresh', { method: 'POST' }, env);
}

describe('POST /trigger-cookie-refresh (production GitHub dispatch)', () => {
  let fetchMock: FetchMock | null = null;
  afterEach(() => {
    fetchMock?.restore();
    fetchMock = null;
  });

  it('dispatches to the correct repo + workflow and reports success on 204', async () => {
    fetchMock = installFetchMock().on('api.github.com', { status: 204 });

    const res = await trigger(baseEnv());
    const body = (await res.json()) as { triggered: boolean };

    expect(body.triggered).toBe(true);
    const call = fetchMock.callsTo('api.github.com')[0];
    expect(call.url).toContain('/repos/bendstaples7/chicago-reno-social-generator/');
    expect(call.url).toContain('/actions/workflows/refresh-jobber-cookies.yml/dispatches');
    // Regression guard: never the old wrong repo.
    expect(call.url).not.toContain('Cotiza');
  });

  it('honors a GITHUB_REPO override', async () => {
    fetchMock = installFetchMock().on('api.github.com', { status: 204 });

    await trigger(baseEnv({ GITHUB_REPO: 'acme/forked-repo' }));

    expect(fetchMock.callsTo('api.github.com')[0].url).toContain('/repos/acme/forked-repo/');
  });

  it('returns a diagnosable error (with detail) on a 404', async () => {
    fetchMock = installFetchMock().on('api.github.com', { status: 404, text: '{"message":"Not Found"}' });

    const res = await trigger(baseEnv());
    const body = (await res.json()) as { triggered: boolean; error: string; detail?: string };

    expect(res.status).toBe(500);
    expect(body.triggered).toBe(false);
    expect(body.error).toContain('GitHub API returned 404');
    expect(body.detail).toContain('Not Found');
  });

  it('fails clearly (and makes no dispatch) when GITHUB_PAT is missing', async () => {
    fetchMock = installFetchMock();

    const res = await trigger(baseEnv({ GITHUB_PAT: '' }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toContain('GITHUB_PAT not configured');
    expect(fetchMock.callsTo('api.github.com')).toHaveLength(0);
  });
});
