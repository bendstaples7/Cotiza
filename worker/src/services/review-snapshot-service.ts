import type { ReviewSnapshot, QuoteLineItem, DepositSchedule } from 'shared';

export interface SnapshotPayload {
  lineItems: Array<{
    id: string;
    productName: string;
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
  terms: string | null;
  notes: string | null;
  customerNote: string | null;
  depositSchedule: DepositSchedule | null;
  totalValue: number;
}

export class ReviewSnapshotService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Take a snapshot of a quote's current state and store it.
   */
  async createSnapshot(
    quoteDraftId: string,
    reviewId: string,
    lineItems: QuoteLineItem[],
    customerNote: string | null,
    depositSchedule: DepositSchedule | null,
    terms?: string | null,
  ): Promise<ReviewSnapshot> {
    const id = crypto.randomUUID();

    const snapshotData: SnapshotPayload = {
      lineItems: lineItems.map((item) => ({
        id: item.id,
        productName: item.productName,
        description: item.description ?? '',
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.quantity * item.unitPrice,
      })),
      terms: terms ?? null,
      notes: customerNote ?? null,
      customerNote: customerNote ?? null,
      depositSchedule: depositSchedule ?? null,
      totalValue: lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
    };

    await this.db.prepare(
      `INSERT INTO quote_review_snapshots (id, quote_draft_id, review_id, snapshot_data)
       VALUES (?, ?, ?, ?)`
    ).bind(id, quoteDraftId, reviewId, JSON.stringify(snapshotData)).run();

    return {
      id,
      quoteDraftId,
      reviewId,
      snapshotData: JSON.stringify(snapshotData),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Retrieve a snapshot by ID.
   */
  async getSnapshot(snapshotId: string): Promise<ReviewSnapshot | null> {
    const row = await this.db.prepare(
      'SELECT id, quote_draft_id, review_id, snapshot_data, created_at FROM quote_review_snapshots WHERE id = ?'
    ).bind(snapshotId).first() as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      quoteDraftId: row.quote_draft_id as string,
      reviewId: row.review_id as string,
      snapshotData: row.snapshot_data as string,
      createdAt: row.created_at as string,
    };
  }

  /**
   * Get the most recent snapshot for a quote draft.
   */
  async getLatestSnapshot(quoteDraftId: string): Promise<ReviewSnapshot | null> {
    const row = await this.db.prepare(
      `SELECT id, quote_draft_id, review_id, snapshot_data, created_at
       FROM quote_review_snapshots
       WHERE quote_draft_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(quoteDraftId).first() as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      quoteDraftId: row.quote_draft_id as string,
      reviewId: row.review_id as string,
      snapshotData: row.snapshot_data as string,
      createdAt: row.created_at as string,
    };
  }

  /**
   * Parse snapshot data into a SnapshotPayload object.
   */
  parseSnapshotData(snapshot: ReviewSnapshot): SnapshotPayload {
    try {
      return JSON.parse(snapshot.snapshotData) as SnapshotPayload;
    } catch {
      throw new Error('Failed to parse snapshot data');
    }
  }
}