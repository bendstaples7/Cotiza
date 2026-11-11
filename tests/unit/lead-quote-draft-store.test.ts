import { describe, it, expect } from 'vitest';
import type { LeadQuoteDraft } from 'shared';
import { toQuoteDraft } from '../../worker/src/services/lead-quote-draft-store.js';

const riskDetail =
  'drywall: the assumption says 40 ft but the request/email says 90 ft, 43 ft — confirm the measurement.';

function buildLead(): LeadQuoteDraft {
  return {
    requestId: 'req-1',
    draftId: null,
    lineItems: [
      {
        name: 'Vinyl Flooring Installation',
        description: 'Install vinyl flooring',
        qty: 930,
        unit: 'sqft',
        unitPrice: 4.5,
        productId: 'prod-vinyl',
      },
      {
        name: 'Baseboard Installation',
        description: 'Install new baseboard throughout',
        qty: 120,
        unit: 'ft',
        unitPrice: 3,
        productId: 'prod-baseboard',
      },
      {
        name: 'Stair Nosing',
        description: 'Install stair nosing',
        qty: 14,
        unit: 'steps',
        unitPrice: null,
        productId: null,
      },
    ],
    milestones: [
      { description: 'Deposit', percentage: 30 },
      { description: 'Balance due on completion', percentage: 70 },
    ],
    customerNote: 'Draft quote prepared from the request.',
    scopeCheck: [
      {
        scope: 'drywall',
        requested: true,
        covered: false,
        note: 'Requested but no catalog line item was selected.',
      },
      { scope: 'floor', requested: true, covered: true },
    ],
    openRisks: [{ kind: 'assumption_conflict', detail: riskDetail }],
    status: 'cotiza_draft',
    jobberQuoteId: null,
    jobberQuoteNumber: null,
    jobberQuoteWebUri: null,
    generatedAt: '2026-11-11T00:00:00.000Z',
  };
}

const ctx = {
  userId: 'user-1',
  requestText: 'Customer needs vinyl flooring installed and hallway drywall repair.',
  clientName: 'Jane Doe',
  propertyAddress: '1 Main St',
  now: new Date('2026-11-11T12:00:00.000Z'),
};

describe('toQuoteDraft', () => {
  it('maps priced lines to resolved line items', () => {
    const draft = toQuoteDraft(buildLead(), ctx);

    expect(draft.lineItems).toHaveLength(2);
    expect(draft.lineItems.every((item) => item.resolved)).toBe(true);
    expect(draft.lineItems[0].unitPrice).toBe(4.5);
    expect(draft.lineItems[0].confidenceScore).toBe(100);
  });

  it('maps the unpriced line and uncovered scope to unresolved items', () => {
    const draft = toQuoteDraft(buildLead(), ctx);

    expect(draft.unresolvedItems).toHaveLength(2);
    expect(draft.unresolvedItems.every((item) => !item.resolved)).toBe(true);
    expect(draft.unresolvedItems.every((item) => item.unitPrice === 0)).toBe(true);
    expect(draft.unresolvedItems.every((item) => Boolean(item.unmatchedReason))).toBe(true);

    const scope = draft.unresolvedItems.find((item) => item.productName === 'drywall');
    expect(scope).toBeDefined();
    expect(scope?.unmatchedReason).toBe('Requested but not in the quote');
  });

  it('maps open risks to action items', () => {
    const draft = toQuoteDraft(buildLead(), ctx);

    expect(draft.actionItems).toHaveLength(1);
    expect(draft.actionItems?.[0].description).toBe(riskDetail);
    expect(draft.actionItems?.[0].completed).toBe(false);
  });

  it('carries the deposit schedule, note and request link', () => {
    const draft = toQuoteDraft(buildLead(), ctx);

    const sum = draft.depositSchedule?.milestones.reduce((total, m) => total + m.percentage, 0);
    expect(sum).toBe(100);
    expect(draft.customerNote).toBe('Draft quote prepared from the request.');
    expect(draft.jobberRequestId).toBe('req-1');
    expect(draft.status).toBe('draft');
    expect(draft.draftNumber).toBe(0);
  });
});
