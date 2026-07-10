import { describe, it, expect, afterEach, vi } from 'vitest';
import { runPipelineProbes } from '../../worker/src/services/pipeline-probes.js';
import { REQUIRED_D1_TABLES } from '../../worker/src/required-d1-tables.js';
import { buildMediaThumbnailPath } from '../../shared/src/media-urls.js';
import { installFetchMock, type FetchMock } from '../helpers/fetch-mock.js';

function createD1Mock(tables: Iterable<string>) {
  const tableSet = new Set(tables);
  return {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes('sqlite_master') && typeof args[0] === 'string') {
            return tableSet.has(args[0]) ? { name: args[0] } : null;
          }
          return null;
        },
      }),
    })),
  };
}

function env(overrides: Record<string, unknown> = {}) {
  const r2Objects = new Map<string, Uint8Array>();
  const r2 = {
    put: vi.fn(async (key: string, value: Uint8Array) => {
      r2Objects.set(key, value);
    }),
    get: vi.fn(async (key: string) => {
      const bytes = r2Objects.get(key);
      if (!bytes) return null;
      return {
        body: bytes,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png'),
      };
    }),
  };
  const db = createD1Mock(REQUIRED_D1_TABLES);
  return {
    AI_TEXT_API_KEY: 'sk-test',
    GITHUB_PAT: 'ghp_test',
    GITHUB_REPO: '',
    FB_PAGE_ACCESS_TOKEN: 'fb-token',
    IG_BUSINESS_ACCOUNT_ID: 'ig-1',
    R2_BUCKET: r2,
    DB: db,
    ...overrides,
  } as never;
}

describe('runPipelineProbes (deep /health/pipelines checks)', () => {
  let fetchMock: FetchMock | null = null;
  afterEach(() => {
    fetchMock?.restore();
    fetchMock = null;
  });

  it('reports ok when all upstreams respond 200', async () => {
    fetchMock = installFetchMock()
      .on('api.openai.com', { status: 200, json: { id: 'gpt-image-1' } })
      .on('api.github.com', { status: 200, json: { id: 1 } })
      .on('graph.facebook.com', { status: 200, json: { id: 'ig-1' } });

    const checks = await runPipelineProbes(env());

    expect(checks.openai.ok).toBe(true);
    expect(checks.github.ok).toBe(true);
    expect(checks.instagram.ok).toBe(true);
    expect(checks.media.ok).toBe(true);
    expect(checks.d1.ok).toBe(true);
  });

  it('flags a GitHub repo/scope problem (the cookie-refresh drift class)', async () => {
    fetchMock = installFetchMock()
      .on('api.openai.com', { status: 200 })
      .on('api.github.com', { status: 404, json: { message: 'Not Found' } })
      .on('graph.facebook.com', { status: 200 });

    const checks = await runPipelineProbes(env());

    expect(checks.github.ok).toBe(false);
    expect(checks.github.detail).toContain('404');
  });

  it('reports missing secrets by name without making any outbound call', async () => {
    fetchMock = installFetchMock();

    const checks = await runPipelineProbes(env({ AI_TEXT_API_KEY: '', GITHUB_PAT: '', FB_PAGE_ACCESS_TOKEN: '' }));

    expect(checks.openai.ok).toBe(false);
    expect(checks.openai.detail).toContain('not set');
    expect(checks.github.ok).toBe(false);
    expect(checks.instagram.ok).toBe(false);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it('media probe round-trips through the public thumbnail route when selfUrl is provided', async () => {
    fetchMock = installFetchMock()
      .on('api.openai.com', { status: 200 })
      .on('api.github.com', { status: 200 })
      .on('graph.facebook.com', { status: 200 });

    const testEnv = env();
    const selfUrl = 'https://social-media-cross-poster.chicago-reno.workers.dev/health/pipelines';
    fetchMock.on('social-media-cross-poster.chicago-reno.workers.dev', {
      status: 200,
      text: '\x89PNG',
      headers: { 'Content-Type': 'image/png' },
    });

    const checks = await runPipelineProbes(testEnv, selfUrl);

    expect(checks.media.ok).toBe(true);
    expect(checks.media.detail).toContain('thumbnail route');
    const thumbnailCall = fetchMock.calls.find((c) => c.url.includes(buildMediaThumbnailPath('_healthcheck/media-probe.png')));
    expect(thumbnailCall).toBeDefined();
  });

  it('flags missing required D1 tables (the oauth_states drift class)', async () => {
    fetchMock = installFetchMock()
      .on('api.openai.com', { status: 200 })
      .on('api.github.com', { status: 200 })
      .on('graph.facebook.com', { status: 200 });

    const checks = await runPipelineProbes(env({
      DB: createD1Mock(['users', 'jobber_tokens', 'jobber_web_session', 'channel_connections']),
    }));

    expect(checks.d1.ok).toBe(false);
    expect(checks.d1.detail).toContain('oauth_states');
  });
});
