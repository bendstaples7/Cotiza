import type { ImportableQuote } from './jobber-quote-importer.js';
import { withAbortTimeout } from '../utils/abort.js';

export type RequestQuoteRecommendedAction = 'import_jobber' | 'open_cotiza' | 'generate';

export interface ResolvedJobberQuote {
  id: string;
  quoteNumber: string;
  quoteStatus: string;
  jobberWebUri: string | null;
  title: string | null;
  createdAt: string;
  importedDraftId: string | null;
}

export interface ResolvedCotizaDraft {
  id: string;
  draftNumber: number;
  jobberQuoteId: string | null;
  sparse: boolean;
}

export interface ResolveRequestQuoteResult {
  jobberQuotes: ResolvedJobberQuote[];
  cotizaDraft: ResolvedCotizaDraft | null;
  recommendedAction: RequestQuoteRecommendedAction;
  jobberLookupFailed?: boolean;
}

const JOBBER_LOOKUP_TIMEOUT_MS = 5_000;

function isSparseDraftRow(row: {
  customer_request_text?: string | null;
  line_item_count?: number | null;
}): boolean {
  const hasText = (row.customer_request_text ?? '').trim().length > 0;
  const lineCount = Number(row.line_item_count ?? 0);
  return !hasText && lineCount === 0;
}

function toResolvedJobberQuote(
  quote: ImportableQuote,
  importedDraftId: string | null,
): ResolvedJobberQuote {
  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    quoteStatus: quote.quoteStatus,
    jobberWebUri: quote.jobberWebUri,
    title: quote.title,
    createdAt: quote.createdAt,
    importedDraftId,
  };
}

export function computeRecommendedAction(input: {
  jobberQuotes: ResolvedJobberQuote[];
  cotizaDraft: ResolvedCotizaDraft | null;
}): RequestQuoteRecommendedAction {
  const unimportedJobber = input.jobberQuotes.filter((q) => !q.importedDraftId);
  if (unimportedJobber.length > 0) {
    return 'import_jobber';
  }

  const importedDraftId = input.jobberQuotes.find((q) => q.importedDraftId)?.importedDraftId;
  if (importedDraftId) {
    return 'open_cotiza';
  }

  if (input.cotizaDraft && !input.cotizaDraft.sparse) {
    return 'open_cotiza';
  }

  return 'generate';
}

export async function resolveRequestQuote(
  db: D1Database,
  userId: string,
  jobberRequestId: string,
  fetchRequestQuotes: (jobberRequestId: string, signal?: AbortSignal) => Promise<ImportableQuote[]>,
): Promise<ResolveRequestQuoteResult> {
  const cotizaRow = await db.prepare(
    `SELECT qd.id,
            qd.draft_number,
            qd.jobber_quote_id,
            qd.customer_request_text,
            (SELECT COUNT(*)
               FROM quote_line_items qli
              WHERE qli.quote_draft_id = qd.id) AS line_item_count
     FROM quote_drafts qd
     WHERE qd.user_id = ? AND qd.jobber_request_id = ? AND qd.status != 'finalized'
     ORDER BY qd.created_at DESC
     LIMIT 1`,
  ).bind(userId, jobberRequestId).first<Record<string, unknown>>();

  const cotizaDraft: ResolvedCotizaDraft | null = cotizaRow
    ? {
        id: cotizaRow.id as string,
        draftNumber: Number(cotizaRow.draft_number),
        jobberQuoteId: (cotizaRow.jobber_quote_id as string) || null,
        sparse: isSparseDraftRow({
          customer_request_text: cotizaRow.customer_request_text as string,
          line_item_count: cotizaRow.line_item_count as number,
        }),
      }
    : null;

  let jobberLookupFailed = false;
  let activeQuotes: ImportableQuote[] = [];

  try {
    activeQuotes = await withAbortTimeout(
      (signal) => fetchRequestQuotes(jobberRequestId, signal),
      JOBBER_LOOKUP_TIMEOUT_MS,
      'Jobber quote lookup timed out',
    );
  } catch {
    jobberLookupFailed = true;
    activeQuotes = [];
  }

  const jobberQuotes: ResolvedJobberQuote[] = [];
  if (activeQuotes.length > 0) {
    const placeholders = activeQuotes.map(() => '?').join(', ');
    const quoteIds = activeQuotes.map((q) => q.id);
    const importedResult = await db.prepare(
      `SELECT jobber_quote_id, id FROM quote_drafts WHERE user_id = ? AND jobber_quote_id IN (${placeholders})`,
    ).bind(userId, ...quoteIds).all<{ jobber_quote_id: string; id: string }>();

    const importedByQuoteId = new Map(
      (importedResult.results ?? []).map((row) => [row.jobber_quote_id, row.id]),
    );

    for (const quote of activeQuotes) {
      jobberQuotes.push(toResolvedJobberQuote(quote, importedByQuoteId.get(quote.id) ?? null));
    }
  }

  const recommendedAction = computeRecommendedAction({ jobberQuotes, cotizaDraft });

  return {
    jobberQuotes,
    cotizaDraft,
    recommendedAction,
    ...(jobberLookupFailed ? { jobberLookupFailed: true } : {}),
  };
}

/** Batch lookup for queue card badges (best-effort, no Cotiza draft resolution). */
export async function fetchJobberQuotesForRequests(
  jobberRequestIds: string[],
  fetchRequestQuotes: (jobberRequestId: string, signal?: AbortSignal) => Promise<ImportableQuote[]>,
): Promise<Record<string, Array<{ quoteNumber: string; quoteStatus: string }>>> {
  const result: Record<string, Array<{ quoteNumber: string; quoteStatus: string }>> = {};

  await Promise.allSettled(
    jobberRequestIds.map(async (jobberRequestId) => {
      try {
        const quotes = await withAbortTimeout(
          (signal) => fetchRequestQuotes(jobberRequestId, signal),
          4_000,
          'Jobber quote lookup timed out',
        );
        if (quotes.length > 0) {
          result[jobberRequestId] = quotes.map((q) => ({
            quoteNumber: q.quoteNumber,
            quoteStatus: q.quoteStatus,
          }));
        }
      } catch {
        // Skip failed row
      }
    }),
  );

  return result;
}
