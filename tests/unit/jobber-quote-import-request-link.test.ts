import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobberQuoteImportService } from '../../worker/src/services/jobber-quote-importer.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { QuoteDraftService } from '../../worker/src/services/quote-draft-service.js';
import type { JobberIntegration } from '../../worker/src/services/jobber-integration.js';
import type { ActivityLogService } from '../../worker/src/services/activity-log-service.js';

describe('JobberQuoteImportService.importQuote jobberRequestId linkage', () => {
  const userId = 'user-1';
  const jobberQuoteId = 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=';
  const jobberRequestId = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzA4NTMwMDQ=';

  let db: ReturnType<typeof createMockD1>;
  let quoteDraftService: QuoteDraftService;
  let jobberIntegration: JobberIntegration;
  let activityLog: ActivityLogService;
  let savedDraft: { id: string; draftNumber: number; jobberRequestId: string | null };

  beforeEach(() => {
    db = createMockD1();
    savedDraft = { id: 'draft-new', draftNumber: 88, jobberRequestId: jobberRequestId };

    quoteDraftService = {
      save: vi.fn().mockImplementation(async (draft) => ({
        ...draft,
        id: savedDraft.id,
        draftNumber: savedDraft.draftNumber,
      })),
      getById: vi.fn().mockImplementation(async () => ({
        id: savedDraft.id,
        draftNumber: savedDraft.draftNumber,
        userId,
        jobberRequestId: savedDraft.jobberRequestId,
        jobberQuoteId,
        status: 'draft',
        customerRequestText: 'Kitchen remodel',
        lineItems: [],
        unresolvedItems: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    } as unknown as QuoteDraftService;

    jobberIntegration = {
      graphqlRequest: vi.fn().mockResolvedValue({
        quote: {
          id: jobberQuoteId,
          quoteNumber: '482',
          title: 'Kitchen remodel',
          message: null,
          quoteStatus: 'draft',
          jobberWebUri: 'https://jobber.example/quote/482',
          createdAt: '2025-01-01T00:00:00Z',
          lineItems: { nodes: [] },
          client: { id: 'c1', firstName: 'Abby', lastName: 'Mason', companyName: null },
          property: null,
          request: { id: jobberRequestId },
          amounts: null,
        },
      }),
    } as unknown as JobberIntegration;

    activityLog = {
      log: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActivityLogService;

    configurePrepareResults(db, [
      { first: null },
      { run: { success: true } },
      { run: { success: true } },
    ]);
  });

  it('sets jobberRequestId from quote.request when importing', async () => {
    const service = new JobberQuoteImportService(db, quoteDraftService, jobberIntegration, activityLog);
    const result = await service.importQuote(jobberQuoteId, userId);

    expect(quoteDraftService.save).toHaveBeenCalledOnce();
    const savedPayload = vi.mocked(quoteDraftService.save).mock.calls[0][0];
    expect(savedPayload.jobberRequestId).toBe(jobberRequestId);
    expect(savedPayload.jobberQuoteId).toBe(jobberQuoteId);
    expect(result.draft.jobberRequestId).toBe(jobberRequestId);
  });
});
