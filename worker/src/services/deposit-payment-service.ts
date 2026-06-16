import type { DepositSchedule, DepositPayment, DepositPaymentStatus, DraftDepositStatus } from 'shared';

/**
 * Calculates the total dollar value of all line items in a quote.
 */
function calculateQuoteTotal(lineItems: Array<{ quantity: number; unitPrice: number }>): number {
  return lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}

/**
 * Calculate the dollar amount for a given percentage of a total (in cents).
 */
function pctToCents(totalCents: number, pct: number): number {
  return Math.round((totalCents * pct) / 100);
}

/**
 * Service for managing deposit payments on finalized quotes.
 *
 * When a quote with a deposit schedule is pushed to Jobber (finalized),
 * this service creates one deposit_payment record per milestone with
 * the calculated dollar amounts. These records track real payment status
 * so deposits are more than just text in a client message.
 */
export class DepositPaymentService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Generate and persist deposit payment records when a quote is finalized.
   *
   * For each milestone in the deposit schedule, creates a payment record
   * with the actual dollar amount (in cents) based on the quote total.
   * Also updates the draft's deposit tracking columns.
   *
   * @returns The number of payment records created.
   */
  async createPaymentRecords(
    draftId: string,
    lineItems: Array<{ quantity: number; unitPrice: number }>,
    depositSchedule: DepositSchedule,
  ): Promise<number> {
    const totalDollars = calculateQuoteTotal(lineItems);
    const totalCents = Math.round(totalDollars * 100);

    const statements: D1PreparedStatement[] = [];

    // Delete any existing payment records for this draft (idempotent)
    statements.push(
      this.db.prepare('DELETE FROM deposit_payments WHERE quote_draft_id = ?').bind(draftId),
    );

    // Create one payment record per milestone
    for (let i = 0; i < depositSchedule.milestones.length; i++) {
      const milestone = depositSchedule.milestones[i];
      const amountCents = pctToCents(totalCents, milestone.percentage);

      statements.push(
        this.db.prepare(
          `INSERT INTO deposit_payments (id, quote_draft_id, milestone_index, percentage, amount_cents, description, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        ).bind(
          crypto.randomUUID(),
          draftId,
          i,
          milestone.percentage,
          amountCents,
          milestone.description,
        ),
      );
    }

    // Update the draft's deposit tracking columns
    const firstMilestoneCents = depositSchedule.milestones.length > 0
      ? pctToCents(totalCents, depositSchedule.milestones[0].percentage)
      : 0;

    statements.push(
      this.db.prepare(
        `UPDATE quote_drafts
            SET deposit_total_cents = ?,
                deposit_paid_cents = 0,
                deposit_status = ?
          WHERE id = ?`,
      ).bind(totalCents, 'pending', draftId),
    );

    await this.db.batch(statements);

    return depositSchedule.milestones.length;
  }

  /**
   * Get all deposit payment records for a draft.
   */
  async getPaymentRecords(draftId: string): Promise<DepositPayment[]> {
    const result = await this.db.prepare(
      `SELECT id, quote_draft_id, milestone_index, percentage, amount_cents,
              description, status, paid_at, payment_method, paid_amount_cents,
              notes, created_at, updated_at
         FROM deposit_payments
        WHERE quote_draft_id = ?
        ORDER BY milestone_index ASC`,
    ).bind(draftId).all();

    return (result.results ?? []).map(mapRowToDepositPayment);
  }

  /**
   * Mark a payment milestone as paid.
   *
   * @param paymentId - The deposit payment record ID.
   * @param opts - Optional payment details (method, amount override, notes).
   * @returns The updated payment record.
   */
  async markPaymentPaid(
    paymentId: string,
    opts?: { paymentMethod?: string; paidAmountCents?: number; notes?: string },
  ): Promise<DepositPayment> {
    const payment = await this.db.prepare(
      `SELECT id, quote_draft_id, milestone_index, percentage, amount_cents,
              description, status, paid_at, payment_method, paid_amount_cents,
              notes, created_at, updated_at
         FROM deposit_payments WHERE id = ?`,
    ).bind(paymentId).first<Record<string, unknown>>();

    if (!payment) {
      throw new Error(`Deposit payment record not found: ${paymentId}`);
    }

    if (payment.status === 'paid') {
      return mapRowToDepositPayment(payment) as DepositPayment;
    }

    const now = new Date().toISOString();
    const paidAmountCents = opts?.paidAmountCents ?? (payment.amount_cents as number);
    const paymentMethod = opts?.paymentMethod ?? null;
    const notes = opts?.notes ?? null;

    await this.db.prepare(
      `UPDATE deposit_payments
          SET status = 'paid',
              paid_at = ?,
              payment_method = ?,
              paid_amount_cents = ?,
              notes = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(now, paymentMethod, paidAmountCents, notes, paymentId).run();

    // Recalculate the total paid for the draft
    await this.recalcDraftDepositTotals(payment.quote_draft_id as string);

    // Return the updated record
    const updated = await this.db.prepare(
      `SELECT id, quote_draft_id, milestone_index, percentage, amount_cents,
              description, status, paid_at, payment_method, paid_amount_cents,
              notes, created_at, updated_at
         FROM deposit_payments WHERE id = ?`,
    ).bind(paymentId).first<Record<string, unknown>>();

    return mapRowToDepositPayment(updated!);
  }

  /**
   * Cancel a payment milestone.
   */
  async cancelPayment(paymentId: string): Promise<DepositPayment> {
    await this.db.prepare(
      `UPDATE deposit_payments
          SET status = 'cancelled', updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'`,
    ).bind(paymentId).run();

    const payment = await this.db.prepare(
      `SELECT id, quote_draft_id, milestone_index, percentage, amount_cents,
              description, status, paid_at, payment_method, paid_amount_cents,
              notes, created_at, updated_at
         FROM deposit_payments WHERE id = ?`,
    ).bind(paymentId).first<Record<string, unknown>>();

    if (payment) {
      await this.recalcDraftDepositTotals(payment.quote_draft_id as string);
    }

    return mapRowToDepositPayment(payment ?? { id: paymentId, status: 'cancelled' } as Record<string, unknown>);
  }

  /**
   * Recalculate aggregate deposit totals on the draft based on its payment records.
   */
  private async recalcDraftDepositTotals(draftId: string): Promise<void> {
    const payments = await this.db.prepare(
      `SELECT amount_cents, status, paid_amount_cents
         FROM deposit_payments WHERE quote_draft_id = ?`,
    ).bind(draftId).all<{ amount_cents: number; status: string; paid_amount_cents: number | null }>();

    const rows = payments.results ?? [];
    const totalCents = rows.reduce((sum, r) => sum + r.amount_cents, 0);
    const paidCents = rows
      .filter(r => r.status === 'paid')
      .reduce((sum, r) => sum + (r.paid_amount_cents ?? r.amount_cents), 0);

    let depositStatus: DraftDepositStatus = 'not_applicable';
    if (totalCents > 0) {
      if (paidCents >= totalCents) {
        depositStatus = 'paid';
      } else if (paidCents > 0) {
        depositStatus = 'partial';
      } else if (rows.some(r => r.status === 'cancelled')) {
        depositStatus = 'cancelled';
      } else {
        depositStatus = 'pending';
      }
    }

    await this.db.prepare(
      `UPDATE quote_drafts
          SET deposit_total_cents = ?,
              deposit_paid_cents = ?,
              deposit_status = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(totalCents, paidCents, depositStatus, draftId).run();
  }

  /**
   * Get deposit payment summary for a quote (from the draft's tracking columns).
   */
  async getDepositSummary(draftId: string): Promise<{
    exists: boolean;
    totalCents: number;
    paidCents: number;
    status: DraftDepositStatus;
    payments: DepositPayment[];
  }> {
    const draft = await this.db.prepare(
      `SELECT deposit_total_cents, deposit_paid_cents, deposit_status
         FROM quote_drafts WHERE id = ?`,
    ).bind(draftId).first<Record<string, unknown>>();

    if (!draft) {
      return { exists: false, totalCents: 0, paidCents: 0, status: 'not_applicable', payments: [] };
    }

    const payments = await this.getPaymentRecords(draftId);
    const totalCents = (draft.deposit_total_cents as number) ?? 0;
    const paidCents = (draft.deposit_paid_cents as number) ?? 0;
    const status = (draft.deposit_status as DraftDepositStatus) ?? 'not_applicable';

    return {
      exists: totalCents > 0 || payments.length > 0,
      totalCents,
      paidCents,
      status,
      payments,
    };
  }
}

// ── Mapper ──────────────────────────────────────────────────────────────

function mapRowToDepositPayment(row: Record<string, unknown>): DepositPayment {
  return {
    id: row.id as string,
    quoteDraftId: row.quote_draft_id as string,
    milestoneIndex: row.milestone_index as number,
    percentage: row.percentage as number,
    amountCents: row.amount_cents as number,
    description: (row.description as string) ?? '',
    status: row.status as DepositPaymentStatus,
    paidAt: (row.paid_at as string) ?? null,
    paymentMethod: (row.payment_method as string) ?? null,
    paidAmountCents: (row.paid_amount_cents as number | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
