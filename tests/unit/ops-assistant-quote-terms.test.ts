import { describe, expect, it, vi } from 'vitest';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { extractMilestoneLines, QUOTE_TERMS_QUERY, QUOTE_TERMS_FALLBACK_QUERY } from '../../worker/src/services/jobber-quote-terms.js';
import { createMockD1 } from './helpers/mock-d1.js';

const quote = {
  id: 'q-715', quoteNumber: '715', title: 'Bathroom', message: 'All work will be completed by licensed contractors.',
  quoteStatus: 'draft', jobberWebUri: 'https://secure.getjobber.com/quotes/1', createdAt: '2026-11-02T00:00:00Z',
  lineItems: { nodes: [{ id: 'li', name: 'Demo', description: 'x', quantity: 8, unitPrice: 70 }] },
  client: { id: 'c', firstName: 'K', lastName: 'S', companyName: null }, request: { id: 'r' },
};
const disclaimer = 'Payment schedule:\n- 50% deposit due upon acceptance\n- 40% due at start of tile work\n- 10% final balance due upon completion\nWarranty: 1 year.';

function jobberWith(...terms: Array<unknown>) {
  const fn = vi.fn().mockResolvedValueOnce({ quote });
  for (const t of terms) {
    if (t instanceof Error) fn.mockRejectedValueOnce(t); else fn.mockResolvedValueOnce(t);
  }
  return { graphqlRequest: fn };
}

describe('read_quote payment terms', () => {
  it('returns amounts, required deposit, disclaimer and milestone lines', async () => {
    const jobber = jobberWith({ quote: {
      id: 'q-715', contractDisclaimer: disclaimer,
      amounts: { subtotal: 6110, discountAmount: 0, taxAmount: 0, total: 6110, depositAmount: 3055 },
      depositRecords: { nodes: [] },
    } });
    const result = await new OpsAssistantRead(jobber, createMockD1() as never).readQuote('u', { quoteId: 'q-715' });
    expect(jobber.graphqlRequest.mock.calls[1][0]).toBe(QUOTE_TERMS_QUERY);
    const terms = (result as { quote: { paymentTerms: Record<string, unknown> } }).quote.paymentTerms;
    expect(terms).toMatchObject({
      availability: 'present', query: 'full',
      amounts: { total: 6110, requiredDepositAmount: 3055, requiredDepositPercentOfTotal: 50 },
      contractDisclaimer: { availability: 'present', untrusted: true },
      depositsCollected: { availability: 'present', records: [] },
    });
    expect((terms.milestoneLines as Array<{ text: string }>).map((m) => m.text)).toEqual([
      '50% deposit due upon acceptance', '40% due at start of tile work', '10% final balance due upon completion',
    ]);
  });

  it('falls back to the minimal query when Jobber rejects a field', async () => {
    const jobber = jobberWith(new Error("Field 'taxAmount' doesn't exist"), { quote: { id: 'q', contractDisclaimer: null, amounts: { total: 100, depositAmount: 0 } } });
    const result = await new OpsAssistantRead(jobber, createMockD1() as never).readQuote('u', { quoteId: 'q-715' });
    expect(jobber.graphqlRequest.mock.calls[2][0]).toBe(QUOTE_TERMS_FALLBACK_QUERY);
    expect(result).toMatchObject({ outcome: 'ok', quote: { paymentTerms: { query: 'minimal', contractDisclaimer: { availability: 'empty' }, depositsCollected: { availability: 'unavailable' } } } });
  });

  it('keeps read_quote working and marks terms unavailable when both reads fail', async () => {
    const jobber = jobberWith(new Error('timeout'), new Error('timeout'));
    const result = await new OpsAssistantRead(jobber, createMockD1() as never).readQuote('u', { quoteId: 'q-715' });
    expect(result).toMatchObject({ outcome: 'ok', quote: { quoteNumber: { value: '715' }, paymentTerms: { availability: 'unavailable' } } });
  });

  it('only extracts lines that look like payment milestones', () => {
    expect(extractMilestoneLines('Permits not included.\n$2,000 due at signing\nTile is 12x24 at 75% coverage')).toEqual(['$2,000 due at signing']);
    expect(extractMilestoneLines(null)).toEqual([]);
  });
});
