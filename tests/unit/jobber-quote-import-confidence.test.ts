import { describe, it, expect } from 'vitest';
import {
  QuoteEngine,
  CONFIDENCE_THRESHOLD,
  applyCatalogMatchingToLineItems,
  detectRequestScopes,
} from '../../worker/src/services/quote-engine.js';
import type { ProductCatalogEntry, QuoteLineItem } from 'shared';

const ceilingCatalog: ProductCatalogEntry = {
  id: 'cat-ceiling',
  name: 'Drywall: Installation of New Drywall',
  unitPrice: 120,
  description: 'Ceiling drywall install',
  category: 'drywall',
  sortOrder: 100,
  scope: 'ceiling',
  source: 'manual',
  quantityMode: null,
  defaultHours: null,
};

const floorCatalog: ProductCatalogEntry = {
  id: 'cat-floor',
  name: 'Flooring: Install New Hardwood',
  unitPrice: 200,
  description: 'Hardwood flooring',
  category: 'flooring',
  sortOrder: 200,
  scope: 'floor',
  source: 'manual',
  quantityMode: null,
  defaultHours: null,
};

describe('QuoteEngine.scoreLineItemsAgainstRequest', () => {
  const engine = new QuoteEngine('', 'https://api.openai.com/v1/chat/completions');

  it('resolves ceiling line items for ceiling-only requests without requiring catalog match', async () => {
    const lineItems: QuoteLineItem[] = [
      {
        id: 'li-1',
        jobberLineItemId: 'jb-1',
        productCatalogEntryId: null,
        productName: 'Drywall: Installation of New Drywall',
        description: 'Ceiling patch',
        quantity: 2,
        unitPrice: 150,
        confidenceScore: 0,
        originalText: 'Drywall: Installation of New Drywall',
        resolved: false,
      },
    ];

    const result = await engine.scoreLineItemsAgainstRequest({
      customerText: 'Customer needs ceiling drywall repaired in the living room.',
      lineItems,
      catalog: [ceilingCatalog, floorCatalog],
      preserveSourceFields: true,
      requireCatalogForResolved: false,
    });

    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].confidenceScore).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.lineItems[0].productCatalogEntryId).toBe('cat-ceiling');
    expect(result.lineItems[0].unitPrice).toBe(150);
    expect(result.unresolvedItems).toHaveLength(0);
  });

  it('moves scope-mismatched flooring items to unresolved for ceiling-only requests', async () => {
    const lineItems: QuoteLineItem[] = [
      {
        id: 'li-floor',
        jobberLineItemId: 'jb-floor',
        productCatalogEntryId: null,
        productName: 'Flooring: Install New Hardwood',
        description: '',
        quantity: 1,
        unitPrice: 500,
        confidenceScore: 0,
        originalText: 'Flooring: Install New Hardwood',
        resolved: false,
      },
    ];

    const result = await engine.scoreLineItemsAgainstRequest({
      customerText: 'Please repaint the ceiling and fix ceiling drywall.',
      lineItems,
      catalog: [ceilingCatalog, floorCatalog],
      preserveSourceFields: true,
      requireCatalogForResolved: false,
    });

    expect(result.lineItems).toHaveLength(0);
    expect(result.unresolvedItems).toHaveLength(1);
    expect(result.unresolvedItems[0].confidenceScore).toBe(0);
    expect(result.unresolvedItems[0].unmatchedReason).toMatch(/scope mismatch/i);
    expect(result.lowConfidenceCount).toBe(1);
  });
});

describe('applyCatalogMatchingToLineItems preserveSourceFields', () => {
  it('links catalog id but keeps Jobber name and unit price on import', () => {
    const matched = applyCatalogMatchingToLineItems(
      [
        {
          id: 'li-1',
          productCatalogEntryId: null,
          productName: 'Drywall: Installation of New Drywall',
          description: 'Jobber desc',
          quantity: 3,
          unitPrice: 175,
          confidenceScore: 90,
          originalText: 'Drywall: Installation of New Drywall',
        },
      ],
      [ceilingCatalog],
      { preserveSourceFields: true },
    );

    expect(matched[0].productCatalogEntryId).toBe('cat-ceiling');
    expect(matched[0].productName).toBe('Drywall: Installation of New Drywall');
    expect(matched[0].unitPrice).toBe(175);
    expect(matched[0].description).toBe('Jobber desc');
  });
});

describe('detectRequestScopes', () => {
  it('detects ceiling scope from customer text', () => {
    const scopes = detectRequestScopes('Need ceiling drywall repair');
    expect(scopes.has('ceiling')).toBe(true);
    expect(scopes.has('floor')).toBe(false);
  });

  it('detects plumbing scope from customer text', () => {
    const scopes = detectRequestScopes('Need a plumber to replace the shower valve');
    expect(scopes.has('plumbing')).toBe(true);
    expect(scopes.has('electrical')).toBe(false);
  });

  it('detects electrical scope from customer text', () => {
    const scopes = detectRequestScopes('Install recessed lighting and new wiring');
    expect(scopes.has('electrical')).toBe(true);
    expect(scopes.has('plumbing')).toBe(false);
  });

  it('detects electrical scope for fixture/light install phrasing', () => {
    const scopes = detectRequestScopes('Install a new light fixture in the kitchen');
    expect(scopes.has('electrical')).toBe(true);
  });

  it('does not treat cosmetic light damage as electrical scope', () => {
    const scopes = detectRequestScopes('Fix light scratches on the ceiling drywall');
    expect(scopes.has('electrical')).toBe(false);
    expect(scopes.has('ceiling')).toBe(true);
  });
});
