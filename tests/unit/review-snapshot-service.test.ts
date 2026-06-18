import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { MockD1Database } from './helpers/mock-d1.js';
import { ReviewSnapshotService } from '../../worker/src/services/review-snapshot-service.js';
import type { ReviewSnapshot, QuoteLineItem, DepositSchedule } from 'shared';

// Mock crypto.randomUUID
const mockUUID = vi.fn();
vi.stubGlobal('crypto', { randomUUID: mockUUID });

describe('ReviewSnapshotService', () => {
  let db: MockD1Database;
  let service: ReviewSnapshotService;

  const mockLineItems: QuoteLineItem[] = [
    {
      id: 'li-1',
      productName: 'Drywall Installation',
      description: 'Install drywall for living room',
      quantity: 1200,
      unitPrice: 8.50,
      confidenceScore: 0.95,
      originalText: 'drywall installation',
      resolved: true,
      productCatalogEntryId: null,
    },
    {
      id: 'li-2',
      productName: 'Paint',
      description: 'Interior paint',
      quantity: 400,
      unitPrice: 3.00,
      confidenceScore: 0.90,
      originalText: 'paint',
      resolved: true,
      productCatalogEntryId: null,
    },
  ];

  const mockDepositSchedule: DepositSchedule = {
    label: 'Standard',
    milestones: [
      { description: 'Deposit', percentage: 50 },
      { description: 'Completion', percentage: 50 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUUID.mockReset();
    mockUUID.mockReturnValue('snapshot-uuid-456');
    db = createMockD1();
    service = new ReviewSnapshotService(db as unknown as D1Database);
  });

  describe('createSnapshot', () => {
    it('stores JSON data in DB', async () => {
      configurePrepareResults(db, [
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const result = await service.createSnapshot(
        'draft-1',
        'review-1',
        mockLineItems,
        'Customer note',
        mockDepositSchedule,
        'terms text',
      );

      expect(result.id).toBe('snapshot-uuid-456');
      expect(result.quoteDraftId).toBe('draft-1');
      expect(result.reviewId).toBe('review-1');

      // Verify the snapshot_data is valid JSON
      const insertCall = db.prepare.mock.calls.find(
        (call: [string]) => call[0].includes('INSERT INTO quote_review_snapshots'),
      );
      expect(insertCall).toBeDefined();

      // The bind call should have JSON string as 4th argument
      const stmt = db._stmts.find(() => true);
      const bindCall = stmt?.bind.mock.calls.find(() => true);
      if (bindCall) {
        const jsonArg = bindCall[3] as string;
        const parsed = JSON.parse(jsonArg);
        expect(parsed.lineItems).toHaveLength(2);
        expect(parsed.totalValue).toBe(1200 * 8.50 + 400 * 3.00);
        expect(parsed.terms).toBe('terms text');
        expect(parsed.customerNote).toBe('Customer note');
        expect(parsed.depositSchedule).toEqual(mockDepositSchedule);
      }
    });

    it('returns a ReviewSnapshot object', async () => {
      configurePrepareResults(db, [
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const result = await service.createSnapshot(
        'draft-1',
        'review-1',
        mockLineItems,
        null,
        null,
      );

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('quoteDraftId', 'draft-1');
      expect(result).toHaveProperty('reviewId', 'review-1');
      expect(result).toHaveProperty('snapshotData');
      expect(result).toHaveProperty('createdAt');
      expect(typeof result.snapshotData).toBe('string');
    });

    it('computes totalValue from line items', async () => {
      configurePrepareResults(db, [
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const result = await service.createSnapshot(
        'draft-1',
        'review-1',
        mockLineItems,
        null,
        null,
      );

      const snapshotData = JSON.parse(result.snapshotData);
      const expectedTotal = 1200 * 8.50 + 400 * 3.00;
      expect(snapshotData.totalValue).toBe(expectedTotal);
    });

    it('handles empty line items', async () => {
      configurePrepareResults(db, [
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const result = await service.createSnapshot(
        'draft-1',
        'review-1',
        [],
        null,
        null,
      );

      const snapshotData = JSON.parse(result.snapshotData);
      expect(snapshotData.lineItems).toHaveLength(0);
      expect(snapshotData.totalValue).toBe(0);
    });
  });

  describe('getSnapshot', () => {
    it('returns snapshot when found', async () => {
      const mockSnapshotData = JSON.stringify({
        lineItems: [],
        terms: null,
        notes: null,
        customerNote: null,
        depositSchedule: null,
        totalValue: 0,
      });

      configurePrepareResults(db, [
        {
          first: {
            id: 'snap-1',
            quote_draft_id: 'draft-1',
            review_id: 'review-1',
            snapshot_data: mockSnapshotData,
            created_at: '2026-06-14T12:00:00.000Z',
          },
        },
      ]);

      const result = await service.getSnapshot('snap-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('snap-1');
      expect(result!.quoteDraftId).toBe('draft-1');
      expect(result!.reviewId).toBe('review-1');
      expect(result!.snapshotData).toBe(mockSnapshotData);
      expect(result!.createdAt).toBe('2026-06-14T12:00:00.000Z');
    });

    it('returns null when snapshot not found', async () => {
      configurePrepareResults(db, [
        { first: null },
      ]);

      const result = await service.getSnapshot('snap-missing');
      expect(result).toBeNull();
    });
  });

  describe('getLatestSnapshot', () => {
    it('returns most recent snapshot for a draft', async () => {
      const mockSnapshotData = JSON.stringify({
        lineItems: [],
        terms: null,
        notes: null,
        customerNote: null,
        depositSchedule: null,
        totalValue: 0,
      });

      configurePrepareResults(db, [
        {
          first: {
            id: 'snap-latest',
            quote_draft_id: 'draft-1',
            review_id: 'review-2',
            snapshot_data: mockSnapshotData,
            created_at: '2026-06-14T13:00:00.000Z',
          },
        },
      ]);

      const result = await service.getLatestSnapshot('draft-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('snap-latest');
      expect(result!.reviewId).toBe('review-2');

      // Verify query orders by created_at DESC and limits to 1
      const queryCall = db.prepare.mock.calls.find(
        (call: [string]) => call[0].includes('ORDER BY created_at DESC'),
      );
      expect(queryCall).toBeDefined();
    });

    it('returns null when no snapshots exist', async () => {
      configurePrepareResults(db, [
        { first: null },
      ]);

      const result = await service.getLatestSnapshot('draft-empty');
      expect(result).toBeNull();
    });
  });

  describe('parseSnapshotData', () => {
    it('returns typed SnapshotPayload object', () => {
      const snapshotData = JSON.stringify({
        lineItems: [
          { id: 'li-1', productName: 'Drywall', description: 'desc', quantity: 100, unitPrice: 10, total: 1000 },
        ],
        terms: null,
        notes: 'customer note',
        customerNote: 'customer note',
        depositSchedule: null,
        totalValue: 1000,
      });

      const snapshot: ReviewSnapshot = {
        id: 'snap-1',
        quoteDraftId: 'draft-1',
        reviewId: 'review-1',
        snapshotData,
        createdAt: '2026-06-14T12:00:00.000Z',
      };

      const parsed = service.parseSnapshotData(snapshot);

      expect(parsed.lineItems).toHaveLength(1);
      expect(parsed.lineItems[0].productName).toBe('Drywall');
      expect(parsed.totalValue).toBe(1000);
      expect(parsed.notes).toBe('customer note');
    });

    it('throws on invalid JSON', () => {
      const snapshot: ReviewSnapshot = {
        id: 'snap-1',
        quoteDraftId: 'draft-1',
        reviewId: 'review-1',
        snapshotData: 'not valid json {{{',
        createdAt: '2026-06-14T12:00:00.000Z',
      };

      expect(() => service.parseSnapshotData(snapshot)).toThrow('Failed to parse snapshot data');
    });

    it('returns all fields from SnapshotPayload type', () => {
      const snapshotData = JSON.stringify({
        lineItems: [],
        terms: 'Net 30',
        notes: 'Some notes',
        customerNote: 'Some notes',
        depositSchedule: {
          label: 'Custom',
          milestones: [{ description: 'Upfront', percentage: 100 }],
        },
        totalValue: 5000,
      });

      const snapshot: ReviewSnapshot = {
        id: 'snap-1',
        quoteDraftId: 'draft-1',
        reviewId: 'review-1',
        snapshotData,
        createdAt: '2026-06-14T12:00:00.000Z',
      };

      const parsed = service.parseSnapshotData(snapshot);

      expect(parsed.terms).toBe('Net 30');
      expect(parsed.depositSchedule).not.toBeNull();
      expect(parsed.depositSchedule!.label).toBe('Custom');
      expect(parsed.totalValue).toBe(5000);
    });
  });
});