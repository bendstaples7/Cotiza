import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobberIntegration } from '../../worker/src/services/jobber-integration.js';
import { ActivityLogService } from '../../worker/src/services/activity-log-service.js';
import {
  finalizeRequestListRead,
  jobberStatusPayload,
  liveJobberRead,
} from '../../worker/src/services/jobber-read.js';
import type { JobberReadMeta } from 'shared';

function createIntegration(opts?: { accessToken?: string; cacheTtlMs?: number; clientId?: string; refreshToken?: string }) {
  const activityLog = new ActivityLogService({} as D1Database);
  vi.spyOn(activityLog, 'log').mockResolvedValue(undefined);
  return new JobberIntegration(activityLog, {
    clientId: opts?.clientId ?? 'client',
    clientSecret: 'secret',
    accessToken: opts?.accessToken ?? 'token',
    refreshToken: opts?.refreshToken ?? 'refresh',
    cacheTtlMs: opts?.cacheTtlMs,
  });
}

const requestNode = {
  id: 'req-1',
  title: 'Kitchen',
  companyName: 'Ada',
  contactName: null,
  phone: null,
  email: null,
  requestStatus: 'new',
  createdAt: '2026-01-01T00:00:00.000Z',
  jobberWebUri: 'https://secure.getjobber.com/requests/1',
  client: null,
  notes: { edges: [] },
  noteAttachments: { edges: [] },
};

function requestsPayload(edges: unknown[]) {
  return {
    requests: {
      edges,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

describe('Jobber read results', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a live empty request list as empty, not failed', async () => {
    const integration = createIntegration();
    vi.spyOn(integration, 'graphqlRequest').mockResolvedValue(requestsPayload([]));

    const result = await integration.fetchCustomerRequests();

    expect(result.status).toBe('empty');
    expect(result.source).toBe('live');
    expect(result.records).toEqual([]);
    expect(result.liveLookupFailed).toBe(false);
    expect(result.error).toBeNull();
    expect(integration.isAvailable()).toBe(true);
  });

  it('reports a live request list with records', async () => {
    const integration = createIntegration();
    vi.spyOn(integration, 'graphqlRequest').mockResolvedValue(requestsPayload([{ node: requestNode }]));

    const result = await integration.fetchCustomerRequests();

    expect(result.status).toBe('live');
    expect(result.records).toHaveLength(1);
    expect(result.records[0].id).toBe('req-1');
    expect(result.liveLookupFailed).toBe(false);
  });

  it('serves a fresh cache without calling it a new live read', async () => {
    const integration = createIntegration({ cacheTtlMs: 60_000 });
    const graphql = vi.spyOn(integration, 'graphqlRequest').mockResolvedValue(requestsPayload([{ node: requestNode }]));

    const first = await integration.fetchCustomerRequests();
    const second = await integration.fetchCustomerRequests();

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('live');
    expect(second.status).toBe('cached');
    expect(second.source).toBe('cache');
    expect(second.records).toHaveLength(1);
    expect(second.liveLookupFailed).toBe(false);
    expect(second.fetchedAt).toBeTruthy();
  });

  it.each([
    ['auth', { accessToken: '', clientId: 'client', refreshToken: 'refresh' }, 'auth'],
    ['timeout', null, 'timeout'],
    ['throttled', null, 'throttled'],
    ['graphql', null, 'graphql'],
  ] as const)('does not turn a %s failure into an empty success', async (kind, opts, code) => {
    const integration = createIntegration(opts ?? undefined);
    if (kind !== 'auth') {
      const message = kind === 'timeout'
        ? 'Jobber API request timed out'
        : kind === 'throttled'
          ? 'Jobber API throttled after max retries'
          : 'Jobber GraphQL error: Cannot query field';
      vi.spyOn(integration, 'graphqlRequest').mockRejectedValue(new Error(message));
    }

    const result = await integration.fetchCustomerRequests();

    expect(result.status).toBe('failed');
    expect(result.records).toEqual([]);
    expect(result.source).toBe('none');
    expect(result.liveLookupFailed).toBe(true);
    expect(result.error?.code).toBe(code);
    expect(integration.isAvailable()).toBe(false);
  });

  it('keeps the previous cache when a later live read fails', async () => {
    const integration = createIntegration({ cacheTtlMs: 15 });
    vi.spyOn(integration, 'graphqlRequest')
      .mockResolvedValueOnce(requestsPayload([{ node: requestNode }]))
      .mockRejectedValueOnce(new Error('Jobber API request timed out'));

    const first = await integration.fetchCustomerRequests();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await integration.fetchCustomerRequests();

    expect(first.status).toBe('live');
    expect(second.status).toBe('failed');
    expect(second.source).toBe('cache');
    expect(second.liveLookupFailed).toBe(true);
    expect(second.error?.code).toBe('timeout');
    expect(second.records).toHaveLength(1);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(integration.isAvailable()).toBe(false);
  });

  it('treats a missing GraphQL connection as a failed read', async () => {
    const integration = createIntegration();
    vi.spyOn(integration, 'graphqlRequest').mockResolvedValue({ requests: { pageInfo: {} } });

    const result = await integration.fetchCustomerRequests();

    expect(result.status).toBe('failed');
    expect(result.records).toEqual([]);
    expect(result.liveLookupFailed).toBe(true);
  });

  it('does not let webhook history mark the live API healthy', () => {
    const failed: JobberReadMeta = {
      status: 'failed',
      source: 'none',
      fetchedAt: null,
      liveLookupFailed: true,
      error: { code: 'auth', message: 'Jobber access token is unavailable.' },
    };

    expect(jobberStatusPayload(failed, true)).toEqual({
      available: false,
      webhookActive: true,
      read: failed,
    });

    const withWebhookRows = finalizeRequestListRead({
      live: failed,
      responseCount: 2,
      webhookRowsUsed: true,
      webhookReadFailed: false,
    });
    expect(withWebhookRows.available).toBe(false);
    expect(withWebhookRows.read.status).toBe('failed');
    expect(withWebhookRows.read.source).toBe('webhook');
    expect(withWebhookRows.read.liveLookupFailed).toBe(true);
  });

  it('keeps a genuine empty live read distinct when saved webhooks are also shown', () => {
    const finalized = finalizeRequestListRead({
      live: liveJobberRead([]),
      responseCount: 1,
      webhookRowsUsed: true,
      webhookReadFailed: false,
    });

    expect(finalized.available).toBe(true);
    expect(finalized.read.status).toBe('empty');
    expect(finalized.read.source).toBe('webhook');
    expect(finalized.read.liveLookupFailed).toBe(false);
  });

  it('does not report an empty live read when the saved-request lookup fails', () => {
    const finalized = finalizeRequestListRead({
      live: liveJobberRead([]),
      responseCount: 0,
      webhookRowsUsed: false,
      webhookReadFailed: true,
    });

    expect(finalized.available).toBe(false);
    expect(finalized.read.status).toBe('failed');
    expect(finalized.read.error?.code).toBe('database');
    expect(finalized.read.liveLookupFailed).toBe(false);
  });
});
