import { describe, it, expect, vi } from 'vitest';
import { JobberQuotePushService } from '../../worker/src/services/jobber-quote-push-service.js';
import { JobberIntegration } from '../../worker/src/services/jobber-integration.js';
import { PlatformError } from '../../worker/src/errors/index.js';
import type { QuoteDraft } from 'shared';

function makeDraft(overrides: Partial<QuoteDraft> = {}): QuoteDraft {
  return {
    id: 'draft-1',
    draftNumber: 42,
    userId: 'user-1',
    customerRequestText: '',
    selectedTemplateId: null,
    selectedTemplateName: null,
    lineItems: [
      {
        id: 'li-1',
        productCatalogEntryId: null,
        productName: 'Tile',
        description: '',
        quantity: 2,
        unitPrice: 10,
        confidenceScore: 1,
        originalText: '',
        resolved: true,
      },
    ],
    unresolvedItems: [],
    jobberRequestId: 'gid://Jobber/Request/1',
    jobberQuoteId: null,
    customerNote: null,
    depositSchedule: null,
    status: 'draft',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as QuoteDraft;
}

describe('JobberQuotePushService.pushToJobber — orphan-quote guard', () => {
  it('signals "created in Jobber, do not retry" when D1 persist fails after a successful remote quoteCreate', async () => {
    const jobberIntegration = {
      graphqlRequest: vi
        .fn()
        .mockResolvedValueOnce({
          request: { id: 'r1', client: { id: 'client-1', clientProperties: { nodes: [{ id: 'prop-1' }] } } },
        })
        .mockResolvedValueOnce({
          quoteCreate: {
            quote: { id: 'Q1', quoteNumber: '1042', quoteStatus: 'DRAFT', jobberWebUri: 'https://jobber/q/1042' },
            userErrors: [],
          },
        }),
    } as never;

    // D1 write fails AFTER the remote quote was created.
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockRejectedValue(new Error('D1 write failed')),
      }),
    } as never;

    const service = new JobberQuotePushService(db, jobberIntegration);

    await expect(service.pushToJobber(makeDraft())).rejects.toMatchObject({
      name: 'PlatformError',
      statusCode: 500,
      description: expect.stringContaining('Do NOT push again'),
    });
  });
});

describe('JobberIntegration — clear not-configured error', () => {
  it('throws a PlatformError (not a raw 500-producing Error) when no token or credentials exist', async () => {
    const activityLog = { log: vi.fn() } as never;
    const jobber = new JobberIntegration(activityLog, {
      clientId: '',
      clientSecret: '',
      accessToken: '',
      refreshToken: '',
    });

    await expect(jobber.graphqlRequest('query { foo }')).rejects.toMatchObject({
      name: 'PlatformError',
      description: expect.stringContaining('Jobber is not configured'),
    });
  });
});
