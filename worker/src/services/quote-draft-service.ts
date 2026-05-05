import { PlatformError } from '../errors/index.js';
import type { ActionItem, QuoteDraft, QuoteDraftUpdate, QuoteLineItem } from 'shared';

export class QuoteDraftService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Save a new quote draft with its line items.
   * Uses INSERT ... SELECT to atomically compute the next draft_number,
   * with retry on unique-constraint violation from concurrent inserts.
   */
  async save(draft: QuoteDraft): Promise<QuoteDraft> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const statements: D1PreparedStatement[] = [
        // Atomically compute next draft_number inside the INSERT so the
        // read and write happen in the same statement, avoiding TOCTOU races.
        this.db.prepare(
          `INSERT INTO quote_drafts (id, user_id, customer_request_text, selected_template_id, selected_template_name, status, jobber_request_id, customer_note, manual_request_id, draft_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(draft_number), 0) + 1 FROM quote_drafts WHERE user_id = ?))`
        ).bind(
          draft.id,
          draft.userId,
          draft.customerRequestText,
          draft.selectedTemplateId,
          draft.selectedTemplateName,
          draft.status,
          draft.jobberRequestId ?? null,
          draft.customerNote ?? null,
          draft.manualRequestId ?? null,
          draft.userId,
        ),
      ];

      const allItems = [
        ...draft.lineItems.map((item, i) => ({ ...item, resolved: true, displayOrder: i })),
        ...draft.unresolvedItems.map((item, i) => ({ ...item, resolved: false, displayOrder: i })),
      ];

      for (const item of allItems) {
        statements.push(
          this.db.prepare(
            "INSERT INTO quote_line_items (id, quote_draft_id, product_catalog_entry_id, product_name, description, quantity, unit_price, confidence_score, original_text, resolved, unmatched_reason, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            item.id,
            draft.id,
            item.productCatalogEntryId,
            item.productName,
            item.description ?? '',
            item.quantity,
            item.unitPrice,
            item.confidenceScore,
            item.originalText,
            item.resolved ? 1 : 0,
            item.unmatchedReason ?? null,
            item.displayOrder,
          ),
        );
      }

      for (const actionItem of draft.actionItems ?? []) {
        statements.push(
          this.db.prepare(
            "INSERT INTO action_items (id, quote_draft_id, line_item_id, description, completed) VALUES (?, ?, ?, ?, ?)"
          ).bind(actionItem.id, draft.id, actionItem.lineItemId, actionItem.description, actionItem.completed ? 1 : 0),
        );
      }

      try {
        await this.db.batch(statements);
        break; // Success — exit retry loop
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isConstraintViolation = msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT');
        if (isConstraintViolation && attempt < MAX_RETRIES - 1) {
          // Regenerate ID to avoid PK collision on retry
          const newId = crypto.randomUUID();
          draft = {
            ...draft,
            id: newId,
            actionItems: draft.actionItems?.map(ai => ({ ...ai, quoteDraftId: newId })),
          };
          continue;
        }
        throw err;
      }
    }

    // Re-read the saved row to get DB-assigned fields (draft_number, timestamps).
    // We reuse the original draft's lineItems/unresolvedItems since they were just inserted.
    const row = await this.db.prepare(
      'SELECT id, user_id, customer_request_text, selected_template_id, selected_template_name, status, jobber_request_id, customer_note, manual_request_id, draft_number, jobber_quote_id, jobber_quote_number, jobber_quote_web_uri, created_at, updated_at FROM quote_drafts WHERE id = ?'
    ).bind(draft.id).first() as any;

    return this.mapDraftRow(row, draft.lineItems, draft.unresolvedItems, draft.actionItems);
  }

  /**
   * Get a single quote draft by ID, scoped to the user.
   */
  async getById(draftId: string, userId: string): Promise<QuoteDraft> {
    const row = await this.db.prepare(
      'SELECT id, user_id, customer_request_text, selected_template_id, selected_template_name, status, jobber_request_id, customer_note, manual_request_id, draft_number, jobber_quote_id, jobber_quote_number, jobber_quote_web_uri, created_at, updated_at FROM quote_drafts WHERE id = ? AND user_id = ?'
    ).bind(draftId, userId).first() as any;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteDraftService',
        operation: 'getById',
        description: 'The quote draft was not found or you do not have permission to view it.',
        recommendedActions: ['Verify the draft exists in your quotes list'],
      });
    }

    const { lineItems, unresolvedItems } = await this.fetchLineItems(draftId);
    const actionItems = await this.fetchActionItems(draftId);
    return this.mapDraftRow(row, lineItems, unresolvedItems, actionItems);
  }

  /**
   * List all quote drafts for a user, sorted by creation date descending (newest first).
   */
  async list(userId: string): Promise<QuoteDraft[]> {
    const result = await this.db.prepare(
      'SELECT id, user_id, customer_request_text, selected_template_id, selected_template_name, status, jobber_request_id, customer_note, manual_request_id, draft_number, jobber_quote_id, jobber_quote_number, jobber_quote_web_uri, created_at, updated_at FROM quote_drafts WHERE user_id = ? ORDER BY created_at DESC'
    ).bind(userId).all();

    const drafts: QuoteDraft[] = [];
    for (const row of result.results as any[]) {
      const { lineItems, unresolvedItems } = await this.fetchLineItems(row.id as string);
      const actionItems = await this.fetchActionItems(row.id as string);
      drafts.push(this.mapDraftRow(row, lineItems, unresolvedItems, actionItems));
    }
    return drafts;
  }

  /**
   * Update a quote draft.
   */
  async update(draftId: string, userId: string, updates: QuoteDraftUpdate): Promise<QuoteDraft> {
    // Verify the draft exists and belongs to the user
    await this.getById(draftId, userId);

    const setClauses: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (updates.selectedTemplateId !== undefined) {
      setClauses.push('selected_template_id = ?');
      values.push(updates.selectedTemplateId);
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      values.push(updates.status);
    }
    if (updates.customerNote !== undefined) {
      setClauses.push('customer_note = ?');
      values.push(updates.customerNote);
    }

    values.push(draftId, userId);

    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        'UPDATE quote_drafts SET ' + setClauses.join(', ') + ' WHERE id = ? AND user_id = ?'
      ).bind(...values),
    ];

    // Replace line items if provided
    if (updates.lineItems !== undefined || updates.unresolvedItems !== undefined) {
      statements.push(
        this.db.prepare('DELETE FROM line_item_rules WHERE quote_draft_id = ?').bind(draftId),
        this.db.prepare('DELETE FROM quote_line_items WHERE quote_draft_id = ?').bind(draftId),
      );

      const resolvedItems = (updates.lineItems ?? []) as QuoteLineItem[];
      const unresolvedItemsList = (updates.unresolvedItems ?? []) as QuoteLineItem[];

      const allItems = [
        ...resolvedItems.map((item, i) => ({ ...item, resolved: true, displayOrder: i })),
        ...unresolvedItemsList.map((item, i) => ({ ...item, resolved: false, displayOrder: i })),
      ];

      for (const item of allItems) {
        statements.push(
          this.db.prepare(
            "INSERT INTO quote_line_items (id, quote_draft_id, product_catalog_entry_id, product_name, description, quantity, unit_price, confidence_score, original_text, resolved, unmatched_reason, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            item.id,
            draftId,
            item.productCatalogEntryId ?? null,
            item.productName,
            item.description ?? '',
            item.quantity,
            item.unitPrice,
            item.confidenceScore,
            item.originalText,
            item.resolved ? 1 : 0,
            item.unmatchedReason ?? null,
            item.displayOrder,
          ),
        );
      }
    }

    // Replace action items if provided; leave unchanged when not provided
    if (updates.actionItems !== undefined) {
      statements.push(
        this.db.prepare('DELETE FROM action_items WHERE quote_draft_id = ?').bind(draftId),
      );

      for (const actionItem of updates.actionItems) {
        if (actionItem.id && actionItem.lineItemId && actionItem.description != null && actionItem.completed != null) {
          statements.push(
            this.db.prepare(
              "INSERT INTO action_items (id, quote_draft_id, line_item_id, description, completed) VALUES (?, ?, ?, ?, ?)"
            ).bind(actionItem.id, draftId, actionItem.lineItemId, actionItem.description, actionItem.completed ? 1 : 0),
          );
        }
      }
    }

    await this.db.batch(statements);

    const row = await this.db.prepare(
      'SELECT id, user_id, customer_request_text, selected_template_id, selected_template_name, status, jobber_request_id, customer_note, manual_request_id, draft_number, jobber_quote_id, jobber_quote_number, jobber_quote_web_uri, created_at, updated_at FROM quote_drafts WHERE id = ?'
    ).bind(draftId).first() as any;

    const { lineItems, unresolvedItems } = await this.fetchLineItems(draftId);
    const actionItems = await this.fetchActionItems(draftId);
    return this.mapDraftRow(row, lineItems, unresolvedItems, actionItems);
  }

  /**
   * Delete a quote draft and its associated line items (via CASCADE).
   */
  async delete(draftId: string, userId: string): Promise<boolean> {
    // Verify ownership before deleting child rows
    const draft = await this.db.prepare(
      'SELECT id FROM quote_drafts WHERE id = ? AND user_id = ?'
    ).bind(draftId, userId).first();

    if (!draft) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteDraftService',
        operation: 'delete',
        description: 'The quote draft was not found or you do not have permission to delete it.',
        recommendedActions: ['Verify the draft exists in your quotes list'],
      });
    }

    // D1 doesn't support CASCADE reliably in all cases, so delete child rows first
    await this.db.batch([
      this.db.prepare('DELETE FROM action_items WHERE quote_draft_id = ?').bind(draftId),
      this.db.prepare('DELETE FROM line_item_rules WHERE quote_draft_id = ?').bind(draftId),
      this.db.prepare('DELETE FROM quote_revision_history WHERE quote_draft_id = ?').bind(draftId),
      this.db.prepare('DELETE FROM quote_media WHERE quote_draft_id = ?').bind(draftId),
      this.db.prepare('DELETE FROM quote_line_items WHERE quote_draft_id = ?').bind(draftId),
      this.db.prepare('DELETE FROM quote_drafts WHERE id = ?').bind(draftId),
    ]);

    return true;
  }

  /**
   * Persist a revision history entry for a draft.
   */
  async addRevisionEntry(draftId: string, userId: string, feedbackText: string): Promise<{ id: string; quoteDraftId: string; feedbackText: string; createdAt: Date }> {
    // Lightweight ownership check
    const exists = await this.db.prepare(
      'SELECT id FROM quote_drafts WHERE id = ? AND user_id = ?'
    ).bind(draftId, userId).first();

    if (!exists) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteDraftService',
        operation: 'addRevisionEntry',
        description: 'The quote draft was not found or you do not have permission.',
        recommendedActions: ['Verify the draft exists in your quotes list'],
      });
    }

    const id = crypto.randomUUID();
    await this.db.prepare(
      `INSERT INTO quote_revision_history (id, quote_draft_id, feedback_text)
       VALUES (?, ?, ?)`
    ).bind(id, draftId, feedbackText).run();

    const row = await this.db.prepare(
      'SELECT id, quote_draft_id, feedback_text, created_at FROM quote_revision_history WHERE id = ?'
    ).bind(id).first() as Record<string, unknown>;

    return {
      id: row.id as string,
      quoteDraftId: row.quote_draft_id as string,
      feedbackText: row.feedback_text as string,
      createdAt: new Date(row.created_at as string),
    };
  }

  // ── Private helpers ──────────────────────────────────────────

  private async fetchLineItems(draftId: string): Promise<{ lineItems: QuoteLineItem[]; unresolvedItems: QuoteLineItem[] }> {
    const result = await this.db.prepare(
      'SELECT id, product_catalog_entry_id, product_name, description, quantity, unit_price, confidence_score, original_text, resolved, unmatched_reason, display_order FROM quote_line_items WHERE quote_draft_id = ? ORDER BY display_order ASC'
    ).bind(draftId).all();

    const lineItems: QuoteLineItem[] = [];
    const unresolvedItems: QuoteLineItem[] = [];

    for (const row of result.results as any[]) {
      const item = this.mapLineItemRow(row);
      if (item.resolved) {
        lineItems.push(item);
      } else {
        unresolvedItems.push(item);
      }
    }

    return { lineItems, unresolvedItems };
  }

  private async fetchActionItems(draftId: string): Promise<ActionItem[]> {
    const result = await this.db.prepare(
      'SELECT id, quote_draft_id, line_item_id, description, completed FROM action_items WHERE quote_draft_id = ? ORDER BY created_at ASC'
    ).bind(draftId).all();

    return (result.results as any[]).map((row) => ({
      id: row.id as string,
      quoteDraftId: row.quote_draft_id as string,
      lineItemId: row.line_item_id as string,
      description: row.description as string,
      completed: row.completed === 1 || row.completed === true,
    }));
  }

  private mapLineItemRow(row: Record<string, unknown>): QuoteLineItem {
    return {
      id: row.id as string,
      productCatalogEntryId: (row.product_catalog_entry_id as string) ?? null,
      productName: row.product_name as string,
      description: (row.description as string) ?? '',
      quantity: Number(row.quantity),
      unitPrice: Number(row.unit_price),
      confidenceScore: row.confidence_score as number,
      originalText: row.original_text as string,
      resolved: row.resolved === 1 || row.resolved === true,
      unmatchedReason: (row.unmatched_reason as string) ?? undefined,
    };
  }

  private mapDraftRow(
    row: Record<string, unknown>,
    lineItems: QuoteLineItem[],
    unresolvedItems: QuoteLineItem[],
    actionItems?: ActionItem[],
  ): QuoteDraft {
    if (row.draft_number == null) {
      console.warn(`[QuoteDraftService] draft_number is NULL for draft id=${row.id}, created_at=${row.created_at} — falling back to 0`);
    }
    return {
      id: row.id as string,
      draftNumber: (row.draft_number as number) ?? 0,
      userId: row.user_id as string,
      customerRequestText: row.customer_request_text as string,
      selectedTemplateId: (row.selected_template_id as string) ?? null,
      selectedTemplateName: (row.selected_template_name as string) ?? null,
      lineItems,
      unresolvedItems,
      jobberRequestId: (row.jobber_request_id as string) ?? null,
      manualRequestId: (row.manual_request_id as string) ?? null,
      jobberQuoteId: (row.jobber_quote_id as string) ?? null,
      jobberQuoteNumber: (row.jobber_quote_number as string) ?? null,
      jobberQuoteWebUri: (row.jobber_quote_web_uri as string) ?? null,
      status: row.status as QuoteDraft['status'],
      actionItems,
      customerNote: (row.customer_note as string) ?? null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
