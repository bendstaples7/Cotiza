import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { MockD1Database } from './helpers/mock-d1.js';
import { ProductivityRatesService } from '../../worker/src/services/productivity-rates-service.js';
import { PlatformError } from '../../worker/src/errors/platform-error.js';

/** A valid D1 row for a productivity rate */
function makeRateRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'pr-drywall',
    variable_name: 'drywall_rate',
    display_name: 'Drywall: Installation of New Drywall',
    sqft_per_hour: 40,
    description: 'Square feet of new drywall a crew can install per hour',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ProductivityRatesService', () => {
  let db: MockD1Database;
  let service: ProductivityRatesService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    service = new ProductivityRatesService(db as unknown as D1Database);
  });

  // ---------------------------------------------------------------------------
  // getAllRates()
  // ---------------------------------------------------------------------------

  describe('getAllRates()', () => {
    it('returns an empty array when the table is empty', async () => {
      configurePrepareResults(db, [{ all: { results: [] } }]);

      const rates = await service.getAllRates();

      expect(rates).toEqual([]);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM productivity_rates'),
      );
    });

    it('returns rates ordered by display_name ascending', async () => {
      const rows = [
        makeRateRow({ id: 'pr-paint', variable_name: 'paint_rate', display_name: 'Interior Painting', sqft_per_hour: 100 }),
        makeRateRow({ id: 'pr-drywall', variable_name: 'drywall_rate', display_name: 'Drywall: Installation of New Drywall', sqft_per_hour: 40 }),
      ];
      configurePrepareResults(db, [{ all: { results: rows } }]);

      const rates = await service.getAllRates();

      expect(rates).toHaveLength(2);
      expect(rates[0].variableName).toBe('paint_rate');
      expect(rates[1].variableName).toBe('drywall_rate');
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY display_name ASC'),
      );
    });

    it('maps all snake_case columns to camelCase fields', async () => {
      configurePrepareResults(db, [{ all: { results: [makeRateRow()] } }]);

      const [rate] = await service.getAllRates();

      expect(rate.id).toBe('pr-drywall');
      expect(rate.variableName).toBe('drywall_rate');
      expect(rate.displayName).toBe('Drywall: Installation of New Drywall');
      expect(rate.sqftPerHour).toBe(40);
      expect(rate.description).toBe('Square feet of new drywall a crew can install per hour');
      expect(rate.createdAt).toBeInstanceOf(Date);
      expect(rate.updatedAt).toBeInstanceOf(Date);
    });
  });

  // ---------------------------------------------------------------------------
  // mapRow() — tested indirectly via getAllRates()
  // ---------------------------------------------------------------------------

  describe('mapRow() (via getAllRates)', () => {
    it('converts sqft_per_hour to a number', async () => {
      // D1 may return REAL as a string in some environments
      configurePrepareResults(db, [{ all: { results: [makeRateRow({ sqft_per_hour: '40.5' })] } }]);

      const [rate] = await service.getAllRates();

      expect(typeof rate.sqftPerHour).toBe('number');
      expect(rate.sqftPerHour).toBe(40.5);
    });

    it('maps null description to null', async () => {
      configurePrepareResults(db, [{ all: { results: [makeRateRow({ description: null })] } }]);

      const [rate] = await service.getAllRates();

      expect(rate.description).toBeNull();
    });

    it('maps undefined description to null', async () => {
      const row = makeRateRow();
      delete row.description;
      configurePrepareResults(db, [{ all: { results: [row] } }]);

      const [rate] = await service.getAllRates();

      expect(rate.description).toBeNull();
    });

    it('converts created_at and updated_at strings to Date instances', async () => {
      configurePrepareResults(db, [
        {
          all: {
            results: [
              makeRateRow({
                created_at: '2025-03-15T12:00:00Z',
                updated_at: '2025-06-01T08:30:00Z',
              }),
            ],
          },
        },
      ]);

      const [rate] = await service.getAllRates();

      expect(rate.createdAt).toBeInstanceOf(Date);
      expect(rate.updatedAt).toBeInstanceOf(Date);
      expect(rate.createdAt.toISOString()).toBe('2025-03-15T12:00:00.000Z');
      expect(rate.updatedAt.toISOString()).toBe('2025-06-01T08:30:00.000Z');
    });
  });

  // ---------------------------------------------------------------------------
  // updateRate()
  // ---------------------------------------------------------------------------

  describe('updateRate()', () => {
    it('updates sqft_per_hour and returns the updated rate', async () => {
      const updatedRow = makeRateRow({ sqft_per_hour: 50, updated_at: '2025-06-15T10:00:00Z' });
      // First call: UPDATE run; second call: SELECT first (via getRateById)
      configurePrepareResults(db, [
        { run: { success: true } },
        { first: updatedRow },
      ]);

      const rate = await service.updateRate('pr-drywall', { sqftPerHour: 50 });

      expect(rate.sqftPerHour).toBe(50);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE productivity_rates'),
      );
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("updated_at = datetime('now')"),
      );
    });

    it('updates optional displayName when provided', async () => {
      const updatedRow = makeRateRow({ display_name: 'Drywall: New Name', sqft_per_hour: 40 });
      configurePrepareResults(db, [
        { run: { success: true } },
        { first: updatedRow },
      ]);

      const rate = await service.updateRate('pr-drywall', {
        sqftPerHour: 40,
        displayName: 'Drywall: New Name',
      });

      expect(rate.displayName).toBe('Drywall: New Name');
    });

    it('updates optional description when provided', async () => {
      const updatedRow = makeRateRow({ description: 'Updated description' });
      configurePrepareResults(db, [
        { run: { success: true } },
        { first: updatedRow },
      ]);

      const rate = await service.updateRate('pr-drywall', {
        sqftPerHour: 40,
        description: 'Updated description',
      });

      expect(rate.description).toBe('Updated description');
    });

    it('throws 404 PlatformError for unknown id', async () => {
      // UPDATE runs fine, but SELECT returns null (id not found)
      configurePrepareResults(db, [
        { run: { success: true } },
        { first: null },
      ]);

      await expect(
        service.updateRate('nonexistent-id', { sqftPerHour: 40 }),
      ).rejects.toThrow(PlatformError);

      configurePrepareResults(db, [
        { run: { success: true } },
        { first: null },
      ]);

      await expect(
        service.updateRate('nonexistent-id', { sqftPerHour: 40 }),
      ).rejects.toMatchObject({
        statusCode: 404,
        component: 'ProductivityRatesService',
        operation: 'getRateById',
      });
    });

    it('throws 400 PlatformError for NaN sqft_per_hour', async () => {
      await expect(
        service.updateRate('pr-drywall', { sqftPerHour: NaN }),
      ).rejects.toMatchObject({ statusCode: 400 });

      // Should not have made any DB calls
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('throws 400 PlatformError for Infinity sqft_per_hour', async () => {
      await expect(
        service.updateRate('pr-drywall', { sqftPerHour: Infinity }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('throws 400 PlatformError for -Infinity sqft_per_hour', async () => {
      await expect(
        service.updateRate('pr-drywall', { sqftPerHour: -Infinity }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('throws 400 PlatformError for zero sqft_per_hour', async () => {
      await expect(
        service.updateRate('pr-drywall', { sqftPerHour: 0 }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('throws 400 PlatformError for negative sqft_per_hour', async () => {
      await expect(
        service.updateRate('pr-drywall', { sqftPerHour: -10 }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('throws 400 PlatformError for empty displayName', async () => {
      await expect(
        service.updateRate('pr-drywall', { sqftPerHour: 40, displayName: '' }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('throws 400 PlatformError for whitespace-only displayName', async () => {
      await expect(
        service.updateRate('pr-drywall', { sqftPerHour: 40, displayName: '   ' }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('trims whitespace from displayName before saving', async () => {
      const updatedRow = makeRateRow({ display_name: 'Trimmed Name' });
      configurePrepareResults(db, [
        { run: { success: true } },
        { first: updatedRow },
      ]);

      const rate = await service.updateRate('pr-drywall', {
        sqftPerHour: 40,
        displayName: '  Trimmed Name  ',
      });

      expect(rate.displayName).toBe('Trimmed Name');
      const updateStmt = db._stmts[0];
      expect(updateStmt.bind).toHaveBeenCalledWith(
        expect.anything(), // sqft_per_hour
        'Trimmed Name',    // trimmed displayName
        expect.anything(), // id
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getRateById()
  // ---------------------------------------------------------------------------

  describe('getRateById()', () => {
    it('returns the rate when found', async () => {
      configurePrepareResults(db, [{ first: makeRateRow() }]);

      const rate = await service.getRateById('pr-drywall');

      expect(rate.id).toBe('pr-drywall');
      expect(rate.variableName).toBe('drywall_rate');
    });

    it('throws 404 PlatformError when not found', async () => {
      configurePrepareResults(db, [{ first: null }]);

      await expect(service.getRateById('missing')).rejects.toThrow(PlatformError);

      configurePrepareResults(db, [{ first: null }]);
      await expect(service.getRateById('missing')).rejects.toMatchObject({
        statusCode: 404,
        description: expect.stringContaining('"missing"'),
      });
    });
  });
});
