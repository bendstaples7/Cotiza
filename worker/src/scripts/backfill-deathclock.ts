/**
 * Backfill deathclock metrics for manual requests and quote drafts that
 * existed before the deathclock feature was deployed (T1.1–T1.11).
 *
 * Cases handled:
 *   Case A — Mark every existing manual_request with `backfilled_at = NOW()`.
 *            The deathclock already works from `created_at`, so no request-side
 *            migration is needed beyond the marker.
 *   Case B — Quote drafts that have `quote_send_events` entries (quote was sent
 *            through the system) but `quote_sent_at` IS NULL.  These were sent
 *            before the deathclock feature existed, so we cannot accurately
 *            compute time-to-send.  Set `metric_status = 'no_data'`.
 *   Case C — Quote drafts with NO `quote_send_events` and NO `quote_sent_at`.
 *            These are still-active drafts or were never sent.  Leave as-is
 *            (deathclock ticks live from request `created_at`).
 *
 * Outputs a summary with counts of each case.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillSummary {
  /** Total manual requests processed. */
  totalRequests: number;
  /** Case A: requests marked with backfilled_at. */
  markedRequests: number;
  /** Case B: quote_drafts set to metric_status = 'no_data'. */
  noDataDrafts: number;
  /** Case C: drafts left as-is (normal / still active). */
  unchangedDrafts: number;
  /** Drafts with quote_sent_at already set (normal sent quotes). */
  sentDrafts: number;
  /** Errors encountered during the run. */
  errors: number;
}

interface DraftRow {
  id: string;
  quote_sent_at: string | null;
}

interface RequestRow {
  id: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Backfill runner
// ---------------------------------------------------------------------------

/**
 * Execute the deathclock backfill across all manual_requests and their linked
 * quote_drafts.  Safe to run on an empty DB (returns all-zero summary).
 * Safe to re-run — updates are idempotent (overwriting with the same values).
 */
export async function runBackfill(db: D1Database): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    totalRequests: 0,
    markedRequests: 0,
    noDataDrafts: 0,
    unchangedDrafts: 0,
    sentDrafts: 0,
    errors: 0,
  };

  // 1. Fetch ALL manual requests
  const allRequests = await db
    .prepare('SELECT id, created_at FROM manual_requests')
    .all<RequestRow>();

  if (!allRequests.results || allRequests.results.length === 0) {
    return summary;
  }

  summary.totalRequests = allRequests.results.length;

  // 2. Prepare reusable statements
  const updateBackfilled = db.prepare(
    'UPDATE manual_requests SET backfilled_at = ? WHERE id = ?',
  );
  const selectDrafts = db.prepare(
    'SELECT id, quote_sent_at FROM quote_drafts WHERE manual_request_id = ?',
  );
  const countSendEvents = db.prepare(
    'SELECT COUNT(*) AS cnt FROM quote_send_events WHERE quote_id = ?',
  );
  const setNoData = db.prepare(
    "UPDATE quote_drafts SET metric_status = 'no_data' WHERE id = ?",
  );

  // 3. Process each request
  for (const request of allRequests.results) {
    try {
      // Case A: Mark request as backfilled
      // If the request has created_at (always should), the deathclock already
      // works correctly — we just record that it was processed.
      const now = new Date().toISOString();
      await updateBackfilled.bind(now, request.id).run();
      summary.markedRequests++;

      // 4. Fetch linked quote drafts
      const drafts = await selectDrafts.bind(request.id).all<DraftRow>();

      if (!drafts.results) continue;

      for (const draft of drafts.results) {
        if (draft.quote_sent_at !== null) {
          // Draft already has quote_sent_at set — normal sent draft.
          // Deathclock already works correctly for this.
          summary.sentDrafts++;
          continue;
        }

        // Check if this draft has quote_send_events
        const countRow = await countSendEvents
          .bind(draft.id)
          .first<{ cnt: number }>();
        const hasSendEvents = (countRow?.cnt ?? 0) > 0;

        if (hasSendEvents) {
          // Case B: The quote was sent through the system (has send events)
          // but quote_sent_at is NULL — sent before deathclock existed.
          // Can't accurately compute time-to-send.
          await setNoData.bind(draft.id).run();
          summary.noDataDrafts++;
        } else {
          // Case C: No send events, no quote_sent_at — still a live draft
          // or was never sent. Deathclock ticks live from request created_at.
          summary.unchangedDrafts++;
        }
      }
    } catch (err) {
      console.error(
        `[backfill] Error processing request ${request.id}:`,
        err,
      );
      summary.errors++;
    }
  }

  return summary;
}