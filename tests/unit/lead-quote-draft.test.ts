import { describe, it, expect } from 'vitest';
import {
  LeadQuoteDraftService,
  findAssumptionConflicts,
  type LeadQuoteDraftDeps,
} from '../../worker/src/services/lead-quote-draft.js';

const requestText =
  'Customer needs vinyl flooring installed, new baseboard throughout, and hallway drywall repair.';
const emailText =
  'Drywall work needing done (three areas): 1) 90 feet wide by 1 ft tall; 2) 43 ft wide';

const assumptions = [
  'Assumed: 930 sq ft of vinyl flooring plus about 14 stair steps.',
  'Assumed: customer supplies the vinyl flooring.',
  'Assumed: hallway drywall cut out about 2 ft high for about 40 ft.',
  'Assumed: new baseboard throughout the downstairs, painted.',
];

function buildDeps(): LeadQuoteDraftDeps {
  return {
    readRequest: async () => ({ customerText: requestText, emailText }),
    listLeadInfo: async () => ({
      assumptions,
      needFromCustomer: [{ label: 'Who supplies the flooring?', answer: 'Customer supplies vinyl' }],
    }),
    listPastQuoteLines: async () => [
      { name: 'Vinyl Flooring Installation', qty: 900, unit: 'sqft', unitPrice: 4.5 },
    ],
    loadCatalog: async () => [
      {
        id: 'prod-vinyl',
        name: 'Vinyl Flooring Installation',
        description: 'Install vinyl flooring',
        unitPrice: 4.5,
        source: 'manual' as const,
        scope: 'floor' as const,
      },
      {
        id: 'prod-baseboard',
        name: 'Baseboard Installation',
        description: 'Install and paint baseboard',
        unitPrice: 6,
        source: 'manual' as const,
        scope: 'perimeter' as const,
      },
      {
        id: 'prod-drywall',
        name: 'Drywall Repair',
        description: 'Patch and finish drywall',
        unitPrice: 8,
        source: 'manual' as const,
        scope: 'wall' as const,
      },
    ],
    loadRules: async () => ({
      label: 'Standard deposit',
      milestones: [
        { description: 'Deposit', percentage: 40 },
        { description: 'Balance due on completion', percentage: 60 },
      ],
    }),
    generateLines: async () => [
      {
        name: 'Vinyl Flooring Installation',
        description: 'Install customer-supplied vinyl',
        qty: 930,
        unit: 'sqft',
        productId: 'prod-vinyl',
      },
      {
        name: 'Baseboard Installation',
        description: 'Install and paint new baseboard',
        qty: 40,
        unit: 'ft',
        productId: 'prod-baseboard',
      },
      {
        name: 'Drywall Repair',
        description: 'Patch hallway drywall cut out',
        qty: 40,
        unit: 'ft',
        productId: 'prod-drywall',
      },
      {
        name: 'Custom stair nosing',
        description: 'Unpriced custom item with no catalog match',
        qty: 14,
        unit: 'each',
        productId: 'prod-missing',
      },
    ],
    writeNoteAndRisks: async () => ({
      customerNote: 'Thanks for the details — here is the draft we put together.',
      openRisks: [],
    }),
    now: () => '2026-11-11T00:00:00.000Z',
  };
}

describe('LeadQuoteDraftService.generate', () => {
  it('builds a deterministic draft from the real-lead fixture', async () => {
    const draft = await new LeadQuoteDraftService().generate(
      { requestId: 'req-1' },
      buildDeps(),
    );

    expect(draft.requestId).toBe('req-1');
    expect(draft.status).toBe('cotiza_draft');
    expect(draft.generatedAt).toBe('2026-11-11T00:00:00.000Z');
  });

  it('keeps milestones summing to 100', async () => {
    const draft = await new LeadQuoteDraftService().generate(
      { requestId: 'req-1' },
      buildDeps(),
    );

    const sum = draft.milestones.reduce((total, milestone) => total + milestone.percentage, 0);
    expect(sum).toBe(100);
  });

  it('lists every assumption in the customer note', async () => {
    const draft = await new LeadQuoteDraftService().generate(
      { requestId: 'req-1' },
      buildDeps(),
    );

    for (const assumption of assumptions) {
      expect(draft.customerNote).toContain(assumption);
    }
  });

  it('marks flooring, baseboard and drywall as requested', async () => {
    const draft = await new LeadQuoteDraftService().generate(
      { requestId: 'req-1' },
      buildDeps(),
    );

    const byScope = new Map(draft.scopeCheck.map((check) => [check.scope, check]));
    for (const scope of ['floor', 'perimeter', 'wall']) {
      expect(byScope.get(scope)?.requested).toBe(true);
      expect(byScope.get(scope)?.covered).toBe(true);
    }
  });

  it('raises a drywall conflict between the assumption and the email', async () => {
    const draft = await new LeadQuoteDraftService().generate(
      { requestId: 'req-1' },
      buildDeps(),
    );

    const conflict = draft.openRisks.find(
      (risk) => risk.kind === 'assumption_conflict' && risk.detail.includes('drywall'),
    );
    expect(conflict).toBeDefined();
    expect(conflict?.detail).toContain('40');
    expect(conflict?.detail).toMatch(/90|43/);
  });

  it('never invents a price when the catalog has none', async () => {
    const draft = await new LeadQuoteDraftService().generate(
      { requestId: 'req-1' },
      buildDeps(),
    );

    const unpriced = draft.lineItems.find((item) => item.name === 'Custom stair nosing');
    expect(unpriced?.unitPrice).toBeNull();

    const priced = draft.lineItems.find((item) => item.name === 'Vinyl Flooring Installation');
    expect(priced?.unitPrice).toBe(4.5);
  });

  it('flags the email measurement when the assumption is also in the compared text', () => {
    // The lead draft route compares the whole draft request text, which already
    // contains the Assumed: lines; the assumption's own 40 ft must not mask the
    // email's 90/43 ft.
    const draftText = [requestText, assumptions.join('\n'), emailText].join('\n\n');
    const risks = findAssumptionConflicts(assumptions, [draftText]);
    const conflict = risks.find(
      (risk) => risk.kind === 'assumption_conflict' && risk.detail.includes('40'),
    );
    expect(conflict).toBeDefined();
    expect(conflict?.detail).toMatch(/90|43/);
  });
});