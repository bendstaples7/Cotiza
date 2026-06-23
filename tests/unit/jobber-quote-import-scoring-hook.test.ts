import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobberQuoteImportService } from '../../worker/src/services/jobber-quote-importer.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { QuoteDraftService } from '../../worker/src/services/quote-draft-service.js';
import type { JobberIntegration } from '../../worker/src/services/jobber-integration.js';
import type { ActivityLogService } from '../../worker/src/services/activity-log-service.js';
import type { QuoteLineItem } from 'shared';

describe('JobberQuoteImportService import scoring hook', () => {
  const userId = 'user-1';
  const jobberQuoteId = 'quote-1';

  let db: ReturnType<typeof createMockD1>;
  let quoteDraftService: QuoteDraftService;
  let jobberIntegration: JobberIntegration;
  let activityLog: ActivityLogService;
  let scoreImportedLineItems: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createMockD1();
    scoreImportedLineItems = vi.fn();

    quoteDraftService = {
      save: vi.fn().mockImplementation(async (draft) => ({
        ...draft,
        id: 'draft-new',
        draftNumber: 42,
      })),
      getById: vi.fn().mockImplementation(async (id) => ({
        id,
        draftNumber: 42,
        userId,
        status: 'draft',
        customerRequestText: 'Ceiling repair',
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
          quoteNumber: '100',
          title: 'Ceiling repair',
          message: null,
          quoteStatus: 'draft',
          jobberWebUri: null,
          createdAt: '2025-01-01T00:00:00Z',
          lineItems: {
            nodes: [
              {
                id: 'jb-li-1',
                name: 'Flooring: Install New Hardwood',
                description: '',
                quantity: 1,
                unitPrice: 400,
              },
            ],
          },
          client: null,
          property: null,
          request: null,
          amounts: null,
        },
      }),
    } as unknown as JobberIntegration;

    activityLog = { log: vi.fn().mockResolvedValue(undefined) } as unknown as ActivityLogService;

    configurePrepareResults(db, [
      { first: null },
      { run: { success: true } },
      { run: { success: true } },
    ]);
  });

  it('partitions line items using the scoring callback', async () => {
    scoreImportedLineItems.mockResolvedValue({
      lineItems: [] as QuoteLineItem[],
      unresolvedItems: [
        {
          id: 'scored-1',
          jobberLineItemId: 'jb-li-1',
          productCatalogEntryId: null,
          productName: 'Flooring: Install New Hardwood',
          description: '',
          quantity: 1,
          unitPrice: 400,
          confidenceScore: 0,
          originalText: 'Flooring: Install New Hardwood',
          resolved: false,
          unmatchedReason: 'Scope mismatch',
        },
      ],
      lowConfidenceCount: 1,
    });

    const service = new JobberQuoteImportService(db, quoteDraftService, jobberIntegration, activityLog);
    const result = await service.importQuote(jobberQuoteId, userId, { scoreImportedLineItems });

    expect(scoreImportedLineItems).toHaveBeenCalledOnce();
    const savedPayload = vi.mocked(quoteDraftService.save).mock.calls[0][0];
    expect(savedPayload.lineItems).toHaveLength(0);
    expect(savedPayload.unresolvedItems).toHaveLength(1);
    expect(result.warnings.some((w) => /below confidence threshold/i.test(w))).toBe(true);
    expect(result.warnings.some((w) => /empty draft/i.test(w))).toBe(false);
  });
});
