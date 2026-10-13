import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import systemsRoutes from '../../worker/src/routes/systems.js';
import { createMockD1, configurePrepareResults } from '../unit/helpers/mock-d1.js';
import type { MockD1Database } from '../unit/helpers/mock-d1.js';

const probeLive = vi.hoisted(() => vi.fn());
const syncProductCatalog = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const webSessionStatus = vi.hoisted(() => vi.fn());

vi.mock('../../worker/src/services/auth-service.js', () => ({
  AuthService: vi.fn().mockImplementation(() => ({
    verifySession: vi.fn().mockResolvedValue({
      id: 'user-test-001',
      email: 'test@chicago-reno.com',
      name: 'Test User',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      lastActiveAt: new Date('2025-01-01T00:00:00Z'),
    }),
  })),
}));

vi.mock('../../worker/src/services/jobber-integration.js', () => ({
  openJobberIntegration: vi.fn(async () => ({
    jobberIntegration: { probeLive, syncProductCatalog },
  })),
}));

vi.mock('../../worker/src/services/jobber-web-session.js', () => ({
  JobberWebSession: vi.fn().mockImplementation(() => ({
    getStatus: webSessionStatus,
  })),
}));

describe('GET /api/systems/status', () => {
  let db: MockD1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    probeLive.mockResolvedValue({
      status: 'live',
      source: 'live',
      fetchedAt: '2026-03-01T00:00:00.000Z',
      liveLookupFailed: false,
    });
    webSessionStatus.mockResolvedValue({ configured: true, expired: false });
  });

  function app() {
    const testApp = new Hono();
    testApp.use('*', async (c, next) => {
      c.env = { DB: db as unknown as D1Database, ENABLE_LOCAL_SYNC: 'true' } as never;
      await next();
    });
    testApp.route('/api/systems', systemsRoutes);
    return testApp;
  }

  it('returns jobber.read from the live probe', async () => {
    configurePrepareResults(db, [
      { first: { count: 2 } },
      { first: { status: 'connected', external_account_name: 'Chicago Reno' } },
    ]);

    const response = await app().request('http://127.0.0.1/api/systems/status', {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      jobber: { available: boolean; webhookActive: boolean; read: { status: string; liveLookupFailed: boolean } };
      jobberSession: { configured: boolean; expired: boolean };
      instagram: { status: string; accountName?: string };
    };
    expect(body.jobber.available).toBe(true);
    expect(body.jobber.webhookActive).toBe(true);
    expect(body.jobber.read.status).toBe('live');
    expect(body.jobber.read.liveLookupFailed).toBe(false);
    expect(body.jobberSession).toEqual({ configured: true, expired: false });
    expect(body.instagram.status).toBe('connected');
    expect(body.instagram.accountName).toBe('Chicago Reno');
    expect(probeLive).toHaveBeenCalledTimes(1);
  });

  it('returns a failed read payload when the probe fails', async () => {
    probeLive.mockResolvedValue({
      status: 'failed',
      source: 'none',
      fetchedAt: null,
      liveLookupFailed: true,
      error: { code: 'timeout', message: 'Timed out.' },
    });
    configurePrepareResults(db, [
      { first: { count: 0 } },
      { first: null },
    ]);

    const response = await app().request('http://127.0.0.1/api/systems/status', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const body = await response.json() as { jobber: { available: boolean; read: { status: string; liveLookupFailed: boolean } } };
    expect(body.jobber.available).toBe(false);
    expect(body.jobber.read.status).toBe('failed');
    expect(body.jobber.read.liveLookupFailed).toBe(true);
  });
});
