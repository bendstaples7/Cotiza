import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockD1 } from './helpers/mock-d1.js';
import type { MockD1Database } from './helpers/mock-d1.js';
import { JobberIntegration } from '../../worker/src/services/jobber-integration.js';
import { ActivityLogService } from '../../worker/src/services/activity-log-service.js';
import { failedJobberRead, liveJobberRead } from '../../worker/src/services/jobber-read.js';

// Minimal mock for ActivityLogService
function createMockActivityLog() {
  const logDb = createMockD1();
  const service = new ActivityLogService(logDb as unknown as D1Database);
  vi.spyOn(service, 'log').mockResolvedValue(undefined);
  return service;
}

function createJobberIntegration(activityLog: ActivityLogService) {
  return new JobberIntegration(activityLog, {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    apiUrl: 'https://api.getjobber.com/api/graphql',
  });
}

const JOBBER_PRODUCTS = [
  { id: 'j1', name: 'Lawn Mowing', unitPrice: 50, description: 'Basic lawn mowing', category: 'Lawn Care', source: 'jobber' as const },
  { id: 'j2', name: 'Hedge Trimming', unitPrice: 75, description: 'Hedge trimming service', category: 'Landscaping', source: 'jobber' as const },
  { id: 'j3', name: 'Snow Removal', unitPrice: 100, description: 'Snow removal', category: undefined, source: 'jobber' as const },
];

describe('JobberIntegration.syncProductCatalog', () => {
  let db: MockD1Database;
  let activityLog: ActivityLogService;
  let integration: JobberIntegration;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    activityLog = createMockActivityLog();
    integration = createJobberIntegration(activityLog);
  });

  it('inserts new products and updates jobber_active flags', async () => {
    vi.spyOn(integration, 'fetchProductCatalog').mockResolvedValue(liveJobberRead(JOBBER_PRODUCTS));

    // Mock batch for inserts — simulate 2 new inserts, 1 conflict (already exists)
    db.batch
      .mockResolvedValueOnce([
        { meta: { changes: 1 } }, // Lawn Mowing inserted
        { meta: { changes: 1 } }, // Hedge Trimming inserted
        { meta: { changes: 0 } }, // Snow Removal already exists
      ])
      // Mock batch for activate/deactivate
      .mockResolvedValueOnce([
        { meta: { changes: 3 } }, // activate
        { meta: { changes: 1 } }, // deactivate
      ]);

    const result = await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');

    expect(result.total).toBe(3);
    expect(result.inserted).toBe(2);
    expect(result.deactivated).toBe(1);

    // Verify insert statements were prepared with correct SQL
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO product_catalog'),
    );
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT(user_id, name) DO NOTHING'),
    );

    // Verify batch was called twice: once for inserts, once for activate/deactivate
    expect(db.batch).toHaveBeenCalledTimes(2);

    // Verify activity log was called with success message
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        component: 'JobberIntegration',
        operation: 'syncProductCatalog',
        severity: 'info',
        description: expect.stringContaining('3 Jobber products'),
      }),
    );
  });

  it('returns zeros when Jobber returns no products', async () => {
    vi.spyOn(integration, 'fetchProductCatalog').mockResolvedValue(liveJobberRead([]));

    const result = await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');

    expect(result.inserted).toBe(0);
    expect(result.deactivated).toBe(0);
    expect(result.total).toBe(0);
    expect(result.outcome).toBe('empty');
    expect(result.read.status).toBe('empty');
    expect(result.read.liveLookupFailed).toBe(false);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('sets correct default values for new products', async () => {
    const singleProduct = [
      { id: 'j1', name: 'Lawn Mowing', unitPrice: 50, description: 'Basic mowing', category: 'Lawn', source: 'jobber' as const },
    ];
    vi.spyOn(integration, 'fetchProductCatalog').mockResolvedValue(liveJobberRead(singleProduct));

    db.batch
      .mockResolvedValueOnce([{ meta: { changes: 1 } }])
      .mockResolvedValueOnce([{ meta: { changes: 1 } }, { meta: { changes: 0 } }]);

    await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');

    // The INSERT SQL should include sort_order=500, keywords=NULL, source='jobber', jobber_active=1
    const insertCall = db.prepare.mock.calls[0][0] as string;
    expect(insertCall).toContain('500');
    expect(insertCall).toContain("'jobber'");
    expect(insertCall).toContain('NULL');

    // Verify bind was called with product values
    const stmt = db._stmts[0];
    expect(stmt.bind).toHaveBeenCalledWith(
      expect.any(String), // UUID
      'user-1',           // userId
      'Lawn Mowing',      // name
      50,                 // unitPrice
      'Basic mowing',     // description
      'Lawn',             // category
    );
  });

  it('passes null for undefined category', async () => {
    const productNoCategory = [
      { id: 'j1', name: 'Custom Work', unitPrice: 0, description: '', source: 'jobber' as const },
    ];
    vi.spyOn(integration, 'fetchProductCatalog').mockResolvedValue(liveJobberRead(productNoCategory));

    db.batch
      .mockResolvedValueOnce([{ meta: { changes: 1 } }])
      .mockResolvedValueOnce([{ meta: { changes: 1 } }, { meta: { changes: 0 } }]);

    await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');

    const stmt = db._stmts[0];
    expect(stmt.bind).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      'Custom Work',
      0,
      '',
      null,
    );
  });

  it('deactivates Jobber-sourced products not in the response', async () => {
    vi.spyOn(integration, 'fetchProductCatalog').mockResolvedValue(liveJobberRead([JOBBER_PRODUCTS[0]]));

    db.batch
      .mockResolvedValueOnce([{ meta: { changes: 0 } }]) // insert batch
      .mockResolvedValueOnce([
        { meta: { changes: 1 } }, // activate
        { meta: { changes: 2 } }, // deactivate 2 products
      ]);

    const result = await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');

    expect(result.deactivated).toBe(2);

    // Verify deactivate SQL targets only source='jobber' products
    const deactivateCall = db.prepare.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('jobber_active = 0'),
    );
    expect(deactivateCall).toBeDefined();
    expect(deactivateCall![0]).toContain("source = 'jobber'");
    expect(deactivateCall![0]).toContain('NOT IN');
  });

  it('handles API errors gracefully and returns zeros', async () => {
    vi.spyOn(integration, 'fetchProductCatalog').mockRejectedValue(new Error('API timeout'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');

    expect(result.inserted).toBe(0);
    expect(result.deactivated).toBe(0);
    expect(result.outcome).toBe('failed');
    expect(result.read.liveLookupFailed).toBe(true);
    expect(result.read.status).toBe('failed');
    expect(db.batch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('syncProductCatalog failed'),
    );

    // Verify error was logged to activity log
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        operation: 'syncProductCatalog',
        description: expect.stringContaining('API timeout'),
      }),
    );

    consoleSpy.mockRestore();
  });

  it('handles database errors gracefully and returns zeros', async () => {
    vi.spyOn(integration, 'fetchProductCatalog').mockResolvedValue(liveJobberRead(JOBBER_PRODUCTS));
    db.batch.mockRejectedValue(new Error('D1 unavailable'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');

    expect(result.inserted).toBe(0);
    expect(result.deactivated).toBe(0);
    expect(result.outcome).toBe('failed');
    expect(result.read.error?.code).toBe('database');
    expect(result.read.liveLookupFailed).toBe(false);
    consoleSpy.mockRestore();
  });

  it('batches inserts in groups of 50', async () => {
    // Create 120 products to test batching (should be 3 batches: 50, 50, 20)
    const manyProducts = Array.from({ length: 120 }, (_, i) => ({
      id: `j${i}`,
      name: `Product ${i}`,
      unitPrice: 10 + i,
      description: `Description ${i}`,
      category: 'General',
      source: 'jobber' as const,
    }));

    vi.spyOn(integration, 'fetchProductCatalog').mockResolvedValue(liveJobberRead(manyProducts));

    // 3 insert batches + 1 activate/deactivate batch
    db.batch
      .mockResolvedValueOnce(Array(50).fill({ meta: { changes: 1 } }))
      .mockResolvedValueOnce(Array(50).fill({ meta: { changes: 1 } }))
      .mockResolvedValueOnce(Array(20).fill({ meta: { changes: 1 } }))
      .mockResolvedValueOnce([{ meta: { changes: 120 } }, { meta: { changes: 0 } }]);

    const result = await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');

    expect(result.inserted).toBe(120);
    expect(result.total).toBe(120);
    // 3 insert batches + 1 activate/deactivate batch = 4 total
    expect(db.batch).toHaveBeenCalledTimes(4);
  });

  it('does not crash when activity log fails during success logging', async () => {
    vi.spyOn(integration, 'fetchProductCatalog').mockResolvedValue(liveJobberRead([JOBBER_PRODUCTS[0]]));
    (activityLog.log as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('log failed'));

    db.batch
      .mockResolvedValueOnce([{ meta: { changes: 1 } }])
      .mockResolvedValueOnce([{ meta: { changes: 1 } }, { meta: { changes: 0 } }]);

    // Should not throw
    const result = await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');
    expect(result.total).toBe(1);
    expect(result.inserted).toBe(1);
  });

  it('does not deactivate catalog rows when the live read failed but cache still has products', async () => {
    vi.spyOn(integration, 'fetchProductCatalog').mockResolvedValue(
      failedJobberRead(new Error('Jobber API throttled after max retries'), {
        records: JOBBER_PRODUCTS,
        fetchedAtMs: Date.now() - 60_000,
      }),
    );

    const result = await integration.syncProductCatalog(db as unknown as D1Database, 'user-1');

    expect(result.outcome).toBe('failed');
    expect(result.deactivated).toBe(0);
    expect(result.read.liveLookupFailed).toBe(true);
    expect(result.read.source).toBe('cache');
    expect(result.read.error?.code).toBe('throttled');
    expect(db.batch).not.toHaveBeenCalled();
  });
});
