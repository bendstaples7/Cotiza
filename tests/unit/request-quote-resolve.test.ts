import { describe, it, expect, vi } from 'vitest';
import {
  computeRecommendedAction,
  resolveRequestQuote,
  type ResolvedCotizaDraft,
  type ResolvedJobberQuote,
} from '../../worker/src/services/request-quote-resolve-service.js';
import type { ImportableQuote } from '../../worker/src/services/jobber-quote-importer.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';

function jobberQuote(overrides: Partial<ResolvedJobberQuote> & { id: string }): ResolvedJobberQuote {
  return {
    id: overrides.id,
    quoteNumber: overrides.quoteNumber ?? '100',
    quoteStatus: overrides.quoteStatus ?? 'draft',
    jobberWebUri: null,
    title: null,
    createdAt: '2025-01-01T00:00:00Z',
    importedDraftId: overrides.importedDraftId ?? null,
  };
}

function cotizaDraft(overrides: Partial<ResolvedCotizaDraft> = {}): ResolvedCotizaDraft {
  return {
    id: overrides.id ?? 'draft-1',
    draftNumber: overrides.draftNumber ?? 87,
    jobberQuoteId: overrides.jobberQuoteId ?? null,
    sparse: overrides.sparse ?? false,
  };
}

describe('computeRecommendedAction', () => {
  it('prefers import when an active Jobber quote is not imported', () => {
    const action = computeRecommendedAction({
      jobberQuotes: [jobberQuote({ id: 'q1' })],
      cotizaDraft: cotizaDraft(),
    });
    expect(action).toBe('import_jobber');
  });

  it('opens Cotiza when Jobber quote is already imported', () => {
    const action = computeRecommendedAction({
      jobberQuotes: [jobberQuote({ id: 'q1', importedDraftId: 'draft-imported' })],
      cotizaDraft: cotizaDraft({ id: 'draft-other' }),
    });
    expect(action).toBe('open_cotiza');
  });

  it('opens Cotiza when a non-sparse local draft exists and no Jobber quotes', () => {
    const action = computeRecommendedAction({
      jobberQuotes: [],
      cotizaDraft: cotizaDraft(),
    });
    expect(action).toBe('open_cotiza');
  });

  it('generates when no Jobber quotes and no usable Cotiza draft', () => {
    const action = computeRecommendedAction({
      jobberQuotes: [],
      cotizaDraft: null,
    });
    expect(action).toBe('generate');
  });

  it('generates when only a sparse Cotiza draft exists', () => {
    const action = computeRecommendedAction({
      jobberQuotes: [],
      cotizaDraft: cotizaDraft({ sparse: true }),
    });
    expect(action).toBe('generate');
  });

  it('prefers Jobber import over an existing Cotiza draft', () => {
    const action = computeRecommendedAction({
      jobberQuotes: [jobberQuote({ id: 'q1' })],
      cotizaDraft: cotizaDraft({ id: 'draft-local' }),
    });
    expect(action).toBe('import_jobber');
  });
});

describe('resolveRequestQuote', () => {
  it('returns import_jobber when Jobber has an unimported quote', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [
      { first: null },
      { all: { results: [] } },
    ]);

    const fetchRequestQuotes = vi.fn().mockResolvedValue([
      {
        id: 'jobber-q-1',
        quoteNumber: '482',
        title: 'Kitchen remodel',
        quoteStatus: 'draft',
        jobberWebUri: null,
        createdAt: '2025-01-01T00:00:00Z',
        message: null,
        lineItems: [],
        client: null,
        property: null,
      },
    ]);

    const result = await resolveRequestQuote(db, 'user-1', 'req-1', fetchRequestQuotes);
    expect(result.recommendedAction).toBe('import_jobber');
    expect(result.jobberQuotes).toHaveLength(1);
    expect(result.jobberQuotes[0].importedDraftId).toBeNull();
  });

  it('returns open_cotiza when Jobber quote is already imported', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [
      { first: null },
      { all: { results: [{ jobber_quote_id: 'jobber-q-1', id: 'draft-99' }] } },
    ]);

    const fetchRequestQuotes = vi.fn().mockResolvedValue([
      {
        id: 'jobber-q-1',
        quoteNumber: '482',
        title: null,
        quoteStatus: 'sent',
        jobberWebUri: null,
        createdAt: '2025-01-01T00:00:00Z',
        message: null,
        lineItems: [],
        client: null,
        property: null,
      },
    ]);

    const result = await resolveRequestQuote(db, 'user-1', 'req-1', fetchRequestQuotes);
    expect(result.recommendedAction).toBe('open_cotiza');
    expect(result.jobberQuotes[0].importedDraftId).toBe('draft-99');
  });

  it('fails open when Jobber lookup fails', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [
      {
        first: {
          id: 'draft-1',
          draft_number: 87,
          jobber_quote_id: null,
          customer_request_text: 'Existing request text',
          line_item_count: 0,
        },
      },
    ]);

    const fetchRequestQuotes = vi.fn().mockRejectedValue(new Error('Jobber unavailable'));

    const result = await resolveRequestQuote(db, 'user-1', 'req-1', fetchRequestQuotes);
    expect(result.jobberLookupFailed).toBe(true);
    expect(result.jobberQuotes).toEqual([]);
    expect(result.recommendedAction).toBe('open_cotiza');
    expect(result.cotizaDraft?.id).toBe('draft-1');
  });

  it('fails open when Jobber lookup times out', async () => {
    vi.useFakeTimers();
    const db = createMockD1();
    configurePrepareResults(db, [
      {
        first: {
          id: 'draft-1',
          draft_number: 87,
          jobber_quote_id: null,
          customer_request_text: 'Existing request text',
          line_item_count: 0,
        },
      },
    ]);

    const fetchRequestQuotes = vi.fn((_id: string, signal?: AbortSignal) =>
      new Promise<ImportableQuote[]>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );

    const resultPromise = resolveRequestQuote(db, 'user-1', 'req-1', fetchRequestQuotes);
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.jobberLookupFailed).toBe(true);
    expect(result.jobberQuotes).toEqual([]);
    expect(result.recommendedAction).toBe('open_cotiza');
    expect(fetchRequestQuotes).toHaveBeenCalledWith('req-1', expect.any(AbortSignal));
  });
});
