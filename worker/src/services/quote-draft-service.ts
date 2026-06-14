import { PlatformError } from '../errors/index.js';
import type { ActionItem, DepositSchedule, GenerationTrace, LineItemRationale, QuoteDraft, QuoteDraftUpdate, QuoteLineItem, SpaceContext, SqftResolutionResult } from 'shared';

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
          `INSERT INTO quote_drafts (id, user_id, customer_request_text, selected_template_id, selected_template_name, status, jobber_request_id, customer_note, manual_request_id, sqft_resolution_json, deposit_schedule, space_context_json, generation_trace_json, draft_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(draft_number), 0) + 1 FROM quote_drafts WHERE user_id = ?))`
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
          draft.sqftResolution ? JSON.stringify(draft.sqftResolution) : null,
          draft.depositSchedule ? JSON.stringify(draft.depositSchedule) : null,
          draft.spaceContext ? JSON.stringify(draft.spaceContext) : null,
          draft.generationTrace ? JSON.stringify(draft.generationTrace) : null,
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
            "INSERT INTO quote_line_items (id, quote_draft_id, product_catalog_entry_id, product_name, description, quantity, unit_price, confidence_score, original_text, resolved, unmatched_reason, display_order, rationale_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
            item.rationale ? JSON.stringify(item.rationale) : null,
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

    // ── Deathclock: record first draft created timestamp ──
    // Sets first_draft_created_at only if currently NULL (first draft for this request).
    // If linked to a manual request, also computes request_to_quote_seconds as the
    // time from manual request creation to first draft creation.
    // Uses the WHERE first_draft_created_at IS NULL guard so subsequent drafts for
    // the same request are no-ops (< 1ms cost).
    if (draft.manualRequestId) {
      await this.db.prepare(
        `UPDATE quote_drafts
            SET first_draft_created_at = datetime('now'),
                request_to_quote_seconds = CAST(
                  (unixepoch('now') - unixepoch((SELECT created_at FROM manual_requests WHERE id = ?))) AS INTEGER
                )
          WHERE id = ? AND first_draft_created_at IS NULL`
      ).bind(draft.manualRequestId, draft.id).run();
    } else if (draft.manualRequestId === null && draft.jobberRequestId) {
      // Jobber-linked draft without manual request — still record draft creation time
      await this.db.prepare(
        `UPDATE quote_drafts
            SET first_draft_created_at = datetime('now')
          WHERE id = ? AND first_draft_created_at IS NULL`
      ).bind(draft.id).run();
    } else if (draft.manualRequestId === null) {
      console.warn(`[QuoteDraftService] Draft ${draft.id} has no manualRequestId — request_to_quote_seconds not computed`);
    }

    // Re-read the saved row to get DB-assigned fields (draft_number, timestamps).
    // We reuse the original draft's lineItems/unresolvedItems since they were just inserted.
    const row = await this.db.prepare(
      'SELECT id, user_id, customer_request_text, selected_template_id, selected_template_name, status, review_status, jobber_request_id, customer_note, manual_request_id, draft_number, jobber_quote_id, jobber_quote_number, jobber_quote_web_uri, sqft_resolution_json, deposit_schedule, space_context_json, generation_trace_json, created_at, updated_at FROM quote_drafts WHERE id = ?'
    ).bind(draft.id).first() as any;

    return this.mapDraftRow(row, draft.lineItems, draft.unresolvedItems, draft.actionItems);
  }

  /**
   * Get a single quote draft by ID, scoped to the user.
   */
  async getById(draftId: string, userId: string): Promise<QuoteDraft> {
    const row = await this.db.prepare(
      'SELECT id, user_id, customer_request_text, selected_template_id, selected_template_name, status, review_status, jobber_request_id, customer_note, manual_request_id, draft_number, jobber_quote_id, jobber_quote_number, jobber_quote_web_uri, sqft_resolution_json, deposit_schedule, space_context_json, generation_trace_json, created_at, updated_at FROM quote_drafts WHERE id = ? AND user_id = ?'
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
      'SELECT id, user_id, customer_request_text, selected_template_id, selected_template_name, status, review_status, jobber_request_id, customer_note, manual_request_id, draft_number, jobber_quote_id, jobber_quote_number, jobber_quote_web_uri, sqft_resolution_json, deposit_schedule, space_context_json, generation_trace_json, created_at, updated_at FROM quote_drafts WHERE user_id = ? ORDER BY created_at DESC'
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
    const existingDraft = await this.getById(draftId, userId);

    // Block modifications when under review
    if (existingDraft.reviewStatus === 'pending_review') {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteDraftService',
        operation: 'update',
        description: 'Cannot modify a quote that is currently under review. Complete or cancel the review first.',
        recommendedActions: ['Wait for the review to complete, or request changes'],
        statusCode: 400,
      });
    }

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

    if (updates.depositSchedule !== undefined) {
      if (updates.depositSchedule !== null) {
        // Validate the schedule
        const schedule = updates.depositSchedule;
        if (!schedule.milestones || schedule.milestones.length < 1 || schedule.milestones.length > 10) {
          throw new PlatformError({
            severity: 'error',
            component: 'QuoteDraftService',
            operation: 'update',
            description: 'Deposit schedule must have between 1 and 10 milestones.',
            recommendedActions: ['Provide a deposit schedule with 1 to 10 milestones'],
          });
        }
        for (const milestone of schedule.milestones) {
          if (!Number.isInteger(milestone.percentage) || milestone.percentage < 1 || milestone.percentage > 100) {
            throw new PlatformError({
              severity: 'error',
              component: 'QuoteDraftService',
              operation: 'update',
              description: `Milestone percentage ${milestone.percentage} must be a whole integer between 1 and 100.`,
              recommendedActions: ['Ensure each milestone percentage is a whole integer between 1 and 100'],
            });
          }
        }
        const sum = schedule.milestones.reduce((acc, m) => acc + m.percentage, 0);
        // Percentages are whole integers; sum must equal exactly 100
        if (sum !== 100) {
          throw new PlatformError({
            severity: 'error',
            component: 'QuoteDraftService',
            operation: 'update',
            description: `Deposit schedule milestone percentages must sum to 100, but they sum to ${sum}.`,
            recommendedActions: ['Adjust milestone percentages so they sum to exactly 100'],
          });
        }
      }
      setClauses.push('deposit_schedule = ?');
      values.push(updates.depositSchedule !== null ? JSON.stringify(updates.depositSchedule) : null);
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
      'SELECT id, user_id, customer_request_text, selected_template_id, selected_template_name, status, review_status, jobber_request_id, customer_note, manual_request_id, draft_number, jobber_quote_id, jobber_quote_number, jobber_quote_web_uri, sqft_resolution_json, deposit_schedule, space_context_json, generation_trace_json, created_at, updated_at FROM quote_drafts WHERE id = ?'
    ).bind(draftId).first() as any;

    const { lineItems, unresolvedItems } = await this.fetchLineItems(draftId);
    const actionItems = await this.fetchActionItems(draftId);
    return this.mapDraftRow(row, lineItems, unresolvedItems, actionItems);
  }

  /**
   * Apply or clear a manual sqft override on a quote draft.
   *
   * - When sqftOverride is a number: sets manualOverride, preserves originalResolution,
   *   and updates the active resolution to reflect the manual_override tier.
   * - When sqftOverride is null: clears the override and restores the original resolution.
   *
   * Requirements: 7.1, 7.2, 7.3, 7.4
   */
  async updateSqftResolution(draftId: string, userId: string, sqftOverride: number | null): Promise<QuoteDraft> {
    const draft = await this.getById(draftId, userId);

    // Block modifications when under review
    if (draft.reviewStatus === 'pending_review') {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteDraftService',
        operation: 'updateSqftResolution',
        description: 'Cannot modify a quote that is currently under review.',
        recommendedActions: ['Wait for the review to complete, or request changes'],
        statusCode: 400,
      });
    }

    let newResolutionJson: string | null;

    if (sqftOverride !== null) {
      // Apply override: preserve original, set active resolution to manual_override
      const currentResolution = draft.sqftResolution?.resolution ?? null;
      const originalResolution = draft.sqftResolution?.originalResolution ?? currentResolution;

      const overrideResult: SqftResolutionResult = {
        resolution: {
          resolved: true,
          value: sqftOverride,
          tier: 'manual_override',
          confidence: 'high',
          metadata: {},
        },
        manualOverride: sqftOverride,
        originalResolution,
      };
      newResolutionJson = JSON.stringify(overrideResult);
    } else {
      // Clear override: restore original resolution
      if (draft.sqftResolution?.originalResolution) {
        const restored: SqftResolutionResult = {
          resolution: draft.sqftResolution.originalResolution,
          manualOverride: null,
          originalResolution: null,
        };
        newResolutionJson = JSON.stringify(restored);
      } else {
        // No original to restore — clear entirely
        newResolutionJson = null;
      }
    }

    await this.db.prepare(
      "UPDATE quote_drafts SET sqft_resolution_json = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    ).bind(newResolutionJson, draftId, userId).run();

    return this.getById(draftId, userId);
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
      'SELECT id, product_catalog_entry_id, product_name, description, quantity, unit_price, confidence_score, original_text, resolved, unmatched_reason, display_order, rationale_json FROM quote_line_items WHERE quote_draft_id = ? ORDER BY display_order ASC'
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
    let rationale: LineItemRationale | undefined;
    if (row.rationale_json) {
      try {
        rationale = JSON.parse(row.rationale_json as string) as LineItemRationale;
      } catch {
        // Ignore malformed rationale — it's supplementary display data
      }
    }
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
      rationale,
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

    // Deserialize sqft_resolution_json if present
    let sqftResolution: SqftResolutionResult | null = null;
    if (row.sqft_resolution_json) {
      try {
        sqftResolution = JSON.parse(row.sqft_resolution_json as string) as SqftResolutionResult;
      } catch {
        console.warn(`[QuoteDraftService] Failed to parse sqft_resolution_json for draft id=${row.id}`);
      }
    }

    // Deserialize deposit_schedule if present
    let depositSchedule: DepositSchedule | null = null;
    if (row.deposit_schedule) {
      try {
        depositSchedule = JSON.parse(row.deposit_schedule as string) as DepositSchedule;
      } catch {
        console.warn(`[QuoteDraftService] Failed to parse deposit_schedule for draft id=${row.id}`);
      }
    }

    // Deserialize space_context_json if present; null/missing is graceful for existing drafts
    let spaceContext: SpaceContext[] | null = null;
    if (row.space_context_json) {
      try {
        const parsed = JSON.parse(row.space_context_json as string);
        spaceContext = Array.isArray(parsed) ? parsed : null;
      } catch {
        console.warn(`[QuoteDraftService] Failed to parse space_context_json for draft id=${row.id}`);
      }
    }

    // Deserialize generation_trace_json if present
    let generationTrace: GenerationTrace | null = null;
    if (row.generation_trace_json) {
      try {
        generationTrace = JSON.parse(row.generation_trace_json as string) as GenerationTrace;
      } catch {
        console.warn(`[QuoteDraftService] Failed to parse generation_trace_json for draft id=${row.id}`);
      }
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
      reviewStatus: (row.review_status as QuoteDraft['reviewStatus']) ?? null,
      actionItems,
      customerNote: (row.customer_note as string) ?? null,
      depositSchedule,
      sqftResolution,
      spaceContext,
      generationTrace,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
