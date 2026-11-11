import type {
  LeadQuoteDraft,
  LeadQuoteDraftLineItem,
  LeadQuoteDraftRisk,
  LeadQuoteDraftScopeCheck,
  PaymentMilestone,
  ProductCatalogEntry,
} from 'shared';
import { detectRequestScopes } from './quote-engine.js';

/** Request text plus any email text the lead carries. */
export interface LeadQuoteDraftRequest {
  customerText: string;
  emailText?: string;
}

/** Assumptions and answers already captured on the lead. */
export interface LeadQuoteDraftLeadInfo {
  assumptions?: string[];
  needFromCustomer?: Array<{ label: string; answer: string | null }>;
}

/** A comparable line from one of the request's past quotes. */
export interface LeadQuoteDraftPastLine {
  name: string;
  description?: string;
  qty?: number;
  unit?: string;
  unitPrice?: number | null;
}

/** The line the model selected; prices are never carried here. */
export interface LeadQuoteDraftLineSpec {
  name: string;
  description: string;
  qty: number;
  unit: string;
  productId?: string | null;
}

/** A seeded deposit rule. */
export interface LeadQuoteDraftDepositRule {
  label: string;
  milestones: PaymentMilestone[];
}

/** Everything the model prompts receive. */
export interface LeadQuoteDraftContext {
  requestId: string;
  customerText: string;
  emailText: string;
  assumptions: string[];
  needFromCustomer: Array<{ label: string; answer: string | null }>;
  pastQuoteLines: LeadQuoteDraftPastLine[];
  catalog: ProductCatalogEntry[];
}

export interface LeadQuoteDraftInput {
  requestId: string;
  draftId?: string | null;
  jobberQuoteId?: string | null;
  jobberQuoteNumber?: string | null;
  jobberQuoteWebUri?: string | null;
}

/**
 * Every external read is injected so the generator can be tested without a
 * database, Jobber or a model. Real adapters live in the routes slice.
 */
export interface LeadQuoteDraftDeps {
  readRequest(requestId: string): Promise<LeadQuoteDraftRequest>;
  listLeadInfo(requestId: string): Promise<LeadQuoteDraftLeadInfo>;
  listPastQuoteLines(requestId: string): Promise<LeadQuoteDraftPastLine[]>;
  loadCatalog(): Promise<ProductCatalogEntry[]>;
  loadRules(): Promise<LeadQuoteDraftDepositRule | null>;
  generateLines(context: LeadQuoteDraftContext): Promise<LeadQuoteDraftLineSpec[]>;
  writeNoteAndRisks(
    context: LeadQuoteDraftContext & { lineItems: LeadQuoteDraftLineItem[] },
  ): Promise<{ customerNote?: string | null; openRisks?: LeadQuoteDraftRisk[] }>;
  now(): string;
}

const DEFAULT_MILESTONES: PaymentMilestone[] = [
  { description: 'Deposit', percentage: 50 },
  { description: 'Balance due on completion', percentage: 50 },
];

const STOP_WORDS = new Set([
  'about',
  'approximately',
  'around',
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'plus',
  'customer',
  'supplies',
  'supply',
  'throughout',
  'downstairs',
  'upstairs',
  'needed',
  'needing',
  'done',
  'areas',
  'area',
  'wide',
  'tall',
  'high',
  'feet',
  'foot',
  'inches',
  'inch',
  'new',
  'existing',
  'install',
  'installed',
  'repair',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractNumbers(text: string): number[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

/** Quantities with a unit ("40 ft", "930 sq ft", "14 steps"), so list markers like "2)" never count. */
function extractMeasures(text: string): string[] {
  const unit = /(\d+(?:\.\d+)?)\s*(sq\.?\s*ft|sqft|square\s+feet|feet|foot|ft|steps?|stairs?)\b/gi;
  return [...text.matchAll(unit)].map((m) => {
    const u = m[2].toLowerCase().replace(/\s+/g, ' ');
    const norm = /sq|square/.test(u) ? 'sq ft' : /feet|foot|ft/.test(u) ? 'ft' : 'steps';
    return `${Number(m[1])} ${norm}`;
  });
}

function keywordsFor(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

function formatNumbers(values: Array<number | string>): string {
  return [...new Set(values)].join(', ');
}

/**
 * The model only selects and narrates; every price comes from the catalog.
 * A line with no catalog match keeps `unitPrice: null`.
 */
function resolveLineItems(
  specs: LeadQuoteDraftLineSpec[],
  catalog: ProductCatalogEntry[],
): LeadQuoteDraftLineItem[] {
  return specs.map((spec) => {
    const entry = findCatalogEntry(spec.productId, spec.name, catalog);
    return {
      name: spec.name,
      description: spec.description || entry?.description || spec.name,
      qty: spec.qty,
      unit: spec.unit,
      unitPrice: entry ? entry.unitPrice : null,
      productId: entry?.id ?? spec.productId ?? null,
    };
  });
}

function findCatalogEntry(
  productId: string | null | undefined,
  name: string,
  catalog: ProductCatalogEntry[],
): ProductCatalogEntry | undefined {
  if (productId) {
    const byId = catalog.find((entry) => entry.id === productId);
    if (byId) return byId;
  }
  const wanted = name.trim().toLowerCase();
  return catalog.find((entry) => entry.name.trim().toLowerCase() === wanted);
}

/**
 * `detectRequestScopes` reports what the request asks for; the selected line
 * items' catalog scopes report what the draft covers.
 */
function buildScopeCheck(
  customerText: string,
  lineItems: LeadQuoteDraftLineItem[],
  catalog: ProductCatalogEntry[],
): LeadQuoteDraftScopeCheck[] {
  const detected = detectRequestScopes(customerText);
  const covered = new Set<string>();
  for (const item of lineItems) {
    const entry = findCatalogEntry(item.productId, item.name, catalog);
    if (entry?.scope && entry.scope !== 'any') covered.add(entry.scope);
  }

  const scopes = new Set<string>();
  for (const scope of detected) {
    if (scope !== 'any') scopes.add(scope);
  }
  for (const scope of covered) scopes.add(scope);

  return [...scopes].sort().map((scope) => {
    const requested = detected.has(scope);
    const isCovered = covered.has(scope);
    return {
      scope,
      requested,
      covered: isCovered,
      ...(requested && !isCovered
        ? { note: 'Requested but no catalog line item was selected.' }
        : {}),
    };
  });
}

/** Percentages always sum to 100, whatever the seeded rule says. */
function normalizeMilestones(source: PaymentMilestone[]): PaymentMilestone[] {
  const cleaned = source
    .filter((milestone) => Number.isFinite(milestone.percentage) && milestone.percentage > 0)
    .map((milestone) => ({
      description: milestone.description || 'Payment',
      percentage: milestone.percentage,
    }));

  if (!cleaned.length) {
    return DEFAULT_MILESTONES.map((milestone) => ({ ...milestone }));
  }

  const total = cleaned.reduce((sum, milestone) => sum + milestone.percentage, 0);
  if (total === 100) return cleaned;

  let remaining = 100;
  return cleaned.map((milestone, index) => {
    const slotsLeft = cleaned.length - index - 1;
    const percentage =
      slotsLeft === 0
        ? remaining
        : Math.max(
            1,
            Math.min(remaining - slotsLeft, Math.round((milestone.percentage / total) * 100)),
          );
    remaining -= percentage;
    return { description: milestone.description, percentage };
  });
}

function buildCustomerNote(narrative: string | null | undefined, assumptions: string[]): string {
  const trimmed = narrative?.trim();
  if (!assumptions.length) {
    return trimmed || 'Draft quote prepared from the request.';
  }
  const parts: string[] = [];
  if (trimmed) parts.push(trimmed);
  parts.push(assumptions.map((assumption) => `- ${assumption.trim()}`).join('\n'));
  parts.push(
    'Please let us know if any assumption above needs correcting and we will update the quote.',
  );
  return parts.join('\n\n');
}

/**
 * A deterministic risk when an assumption's measurement disagrees with the
 * request/email measurement for the same item.
 */
function findAssumptionConflicts(assumptions: string[], texts: string[]): LeadQuoteDraftRisk[] {
  const risks: LeadQuoteDraftRisk[] = [];

  for (const assumption of assumptions) {
    const assumptionNumbers = extractMeasures(assumption);
    if (!assumptionNumbers.length) continue;

    const keywords = keywordsFor(assumption);
    if (!keywords.length) continue;

    for (const text of texts) {
      if (!text.trim()) continue;
      const lower = text.toLowerCase();
      const sharedKeyword = keywords.find((keyword) =>
        new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(lower),
      );
      if (!sharedKeyword) continue;

      const externalNumbers = extractMeasures(text);
      if (!externalNumbers.length) continue;
      if (assumptionNumbers.some((value) => externalNumbers.includes(value))) continue;

      risks.push({
        kind: 'assumption_conflict',
        detail: `${sharedKeyword}: the assumption says ${formatNumbers(assumptionNumbers)} but the request/email says ${formatNumbers(externalNumbers)} — confirm the measurement. (${assumption})`,
      });
      break;
    }
  }

  return risks;
}

export class LeadQuoteDraftService {
  /**
   * Builds a draft quote from data Cotiza already holds. Never sends, never
   * writes to Jobber and never writes to D1.
   */
  async generate(input: LeadQuoteDraftInput, deps: LeadQuoteDraftDeps): Promise<LeadQuoteDraft> {
    const request = await deps.readRequest(input.requestId);
    const info = await deps.listLeadInfo(input.requestId);
    const pastQuoteLines = await deps.listPastQuoteLines(input.requestId);
    const catalog = await deps.loadCatalog();
    const rule = await deps.loadRules();

    const assumptions = info.assumptions ?? [];
    const needFromCustomer = info.needFromCustomer ?? [];
    const context: LeadQuoteDraftContext = {
      requestId: input.requestId,
      customerText: request.customerText,
      emailText: request.emailText ?? '',
      assumptions,
      needFromCustomer,
      pastQuoteLines,
      catalog,
    };

    const lineItems = resolveLineItems(await deps.generateLines(context), catalog);
    const narrative = await deps.writeNoteAndRisks({ ...context, lineItems });

    const openRisks: LeadQuoteDraftRisk[] = [
      ...(narrative.openRisks ?? []),
      ...findAssumptionConflicts(assumptions, [request.customerText, request.emailText ?? '']),
    ];

    return {
      requestId: input.requestId,
      draftId: input.draftId ?? null,
      lineItems,
      milestones: normalizeMilestones(rule?.milestones ?? []),
      customerNote: buildCustomerNote(narrative.customerNote, assumptions),
      scopeCheck: buildScopeCheck(request.customerText, lineItems, catalog),
      openRisks,
      status: input.jobberQuoteId ? 'pushed' : 'cotiza_draft',
      jobberQuoteId: input.jobberQuoteId ?? null,
      jobberQuoteNumber: input.jobberQuoteNumber ?? null,
      jobberQuoteWebUri: input.jobberQuoteWebUri ?? null,
      generatedAt: deps.now(),
    };
  }
}