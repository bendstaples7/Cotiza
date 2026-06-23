import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManualRequestService } from '../../worker/src/services/manual-request-service.js';
import { createMockD1 } from './helpers/mock-d1.js';

describe('ManualRequestService.list() SQL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes jobber enrichment columns on both UNION branches', async () => {
    let capturedSql = '';
    const db = createMockD1();
    db.prepare.mockImplementation((sql: string) => {
      capturedSql = sql;
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true, meta: {} }),
        raw: vi.fn().mockResolvedValue([]),
      };
      stmt.bind.mockReturnValue(stmt);
      return stmt;
    });

    const service = new ManualRequestService(db as unknown as D1Database);
    await service.list({ userId: 'user-1', includeDeathclock: true, sortBy: 'age_desc' });

    // Manual branch — NULL placeholders for Jobber-only columns
    expect(capturedSql).toMatch(/'manual' AS request_source,\s*NULL AS jobber_title/);
    expect(capturedSql).toContain('NULL AS jobber_description');
    expect(capturedSql).toContain('NULL AS jobber_request_body');

    // Jobber branch — populated enrichment columns
    expect(capturedSql).toContain('jwr.title AS jobber_title');
    expect(capturedSql).toContain('jwr.description AS jobber_description');
    expect(capturedSql).toContain('jwr.request_body AS jobber_request_body');
    expect(capturedSql).toContain("json_extract(jwr.request_body, '$.createdAt')");
    expect(capturedSql).toContain('SELECT MIN(jwr_age.received_at)');
  });

  it('list() completes without error when deathclock is disabled', async () => {
    const db = createMockD1();
    const service = new ManualRequestService(db as unknown as D1Database);
    await expect(
      service.list({ userId: 'user-1', includeDeathclock: false, sortBy: 'age_desc' }),
    ).resolves.toEqual([]);
  });
});
