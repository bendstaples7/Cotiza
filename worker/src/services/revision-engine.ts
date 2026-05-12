import { PlatformError } from '../errors/index.js';
import { deduplicateLineItems, sortLineItemsByCatalog } from './line-item-utils.js';
import { executeRules } from './rules-engine.js';
import type { ProductCatalogEntry, QuoteLineItem, StructuredRule, AuditEntry, EngineLineItem, DepositSchedule } from 'shared';

export interface AIActionItem {
  lineItemProductName: string;
  description: string;
}

const REVISION_TIMEOUT_MS = 300_000;
const CONFIDENCE_THRESHOLD = 70;

export interface RevisionInput {
  feedbackText: string;
  customerRequestText: string;
  currentLineItems: QuoteLineItem[];
  currentUnresolvedItems: QuoteLineItem[];
  catalog: ProductCatalogEntry[];
  structuredRules?: StructuredRule[];
}

export interface RevisionOutput {
  lineItems: QuoteLineItem[];
  unresolvedItems: QuoteLineItem[];
  /** Action items detected by the AI for line items needing additional user input. */
  actionItems?: AIActionItem[];
  /** True when the AI response could not be parsed and the original items were returned unchanged. */
  revisionFailed?: boolean;
  /** Audit trail from the deterministic rules engine, if structured rules were applied. */
  rulesEngineAuditTrail?: AuditEntry[];
  /** Customer note produced by the rules engine, if any customer note actions fired. */
  customerNote?: string | null;
  /** Deposit schedule produced by the rules engine, if any set_deposit_schedule actions fired. */
  depositSchedule?: DepositSchedule | null;
}

interface AILineItem {
  productCatalogEntryId: string | null;
  productName: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  confidenceScore: number;
  originalText: string;
  unmatchedReason?: string;
  ruleIdsApplied?: string[];
}

const SYSTEM_PROMPT = [
  'You are a quote revision assistant for a home services company.',
  'You will receive the original customer request, the current line items of a quote draft, a product catalog, and user feedback.',
  'Interpret the feedback as delta operations on the current line items.',
  '',
  'SUPPORTED OPERATIONS:',
  '- Reorder line items (e.g., "move underlayment before hardwood installation")',
  '- Change quantity on existing items (e.g., "increase drywall to 12 sheets")',
  '- Adjust unit price on existing items (e.g., "change labor rate to $75/hour")',
  '- Remove line items (e.g., "remove the painting line item")',
  '- Add new line items ONLY when the feedback explicitly requests it (e.g., "add trim installation")',
  '',
  'RULES:',
  '- Preserve all line items NOT referenced in the feedback without modification.',
  '- CRITICAL: Do NOT add line items that the feedback does not explicitly ask for. Only add items when the user clearly requests a specific addition.',
  '- When the feedback references the customer request (e.g., "if the request mentions X, add Y"), check the ORIGINAL CUSTOMER REQUEST section to evaluate the condition.',
  '- When adding new items, match against the provided catalog by name. Use catalog pricing for matched items.',
  '- When a catalog product has [matches: ...] keywords, use those to determine the best match. If the customer request or feedback text contains one of the keywords, prefer that product over similar alternatives.',
  '- Set productName to the EXACT catalog product name for matched items.',
  '- If a new item cannot be matched to the catalog, include it with a descriptive unmatchedReason.',
  '- Assign confidence scores (0-100) for each item.',
  '- Use unit prices from the catalog for matched items.',
  '- When BUSINESS RULES are provided, follow them when revising line items. Rules can change description, quantity, and unitPrice on a line item. productName must always match the exact catalog product name. For each line item, include a "ruleIdsApplied" array listing the IDs of any business rules that influenced that line item. If no rules apply, use an empty array.',
  '- CRITICAL: Do NOT include duplicate line items. Each product should appear at most once. If the same product applies to multiple areas, use a single line item with an appropriate quantity instead of separate entries.',
  '',
  'ACTION ITEMS:',
  '- For each line item, determine if the customer provided enough information to accurately price it.',
  '- If a line item requires measurements (e.g., square footage, linear feet) not mentioned in the request, add an action item.',
  '- If a line item requires a specific quantity (e.g., number of cabinets, fixtures, outlets) that the customer did not specify, add an action item.',
  '- Do NOT add action items for line items where the customer provided sufficient detail.',
  '- Action item descriptions should be concise and actionable (e.g., "Square footage needed for accurate pricing", "Number of cabinets to install needed").',
  '',
  'RESPONSE FORMAT (strict JSON):',
  '{',
  '  "lineItems": [',
  '    {',
  '      "productName": "exact catalog product name",',
  '      "description": "line item description (include if a rule modifies it, otherwise omit)",',
  '      "quantity": 1,',
  '      "unitPrice": 0,',
  '      "confidenceScore": 85,',
  '      "originalText": "original text for this item",',
  '      "unmatchedReason": "reason or omit if matched",',
  '      "ruleIdsApplied": ["rule-id-1", "rule-id-2"]',
  '    }',
  '  ],',
  '  "actionItems": [',
  '    {',
  '      "lineItemProductName": "exact product name from lineItems",',
  '      "description": "What information is needed"',
  '    }',
  '  ]',
  '}',
  '',
  'Return ONLY valid JSON. No markdown, no code fences.',
].join('\n');

export class RevisionEngine {
  private readonly apiKey: string;
  private readonly apiUrl: string;

  constructor(apiKey: string, apiUrl: string) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  async revise(input: RevisionInput): Promise<RevisionOutput> {
    if (!this.apiKey) {
      throw new PlatformError({
        severity: 'error',
        component: 'RevisionEngine',
        operation: 'revise',
        description: 'AI text API key is not configured.',
        recommendedActions: ['Set AI_TEXT_API_KEY in your environment'],
      });
    }

    const userPrompt = this.buildPrompt(input);
    const systemPrompt = SYSTEM_PROMPT;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REVISION_TIMEOUT_MS);

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.apiKey,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 2000,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new PlatformError({
          severity: 'error',
          component: 'RevisionEngine',
          operation: 'revise',
          description: `OpenAI API error (${response.status}): ${errText}`,
          recommendedActions: ['Try again'],
        });
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
      return await this.parseAndValidate(raw, input);
    } catch (err) {
      if (err instanceof PlatformError) throw err;

      const isAbort = err instanceof Error && err.name === 'AbortError';
      throw new PlatformError({
        severity: 'error',
        component: 'RevisionEngine',
        operation: 'revise',
        description: isAbort
          ? 'Quote revision timed out after 5 minutes.'
          : `Quote revision failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        recommendedActions: ['Try again'],
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildPrompt(input: RevisionInput): string {
    const parts: string[] = [];

    parts.push('ORIGINAL CUSTOMER REQUEST:');
    parts.push(input.customerRequestText || '(no customer request text available)');

    parts.push('\nCURRENT LINE ITEMS:');
    if (input.currentLineItems.length === 0 && input.currentUnresolvedItems.length === 0) {
      parts.push('(no current line items)');
    } else {
      for (const item of input.currentLineItems) {
        parts.push(`- ${item.productName} — qty: ${item.quantity}, price: $${item.unitPrice}`);
      }
      if (input.currentUnresolvedItems.length > 0) {
        parts.push('\nUNRESOLVED ITEMS:');
        for (const item of input.currentUnresolvedItems) {
          parts.push(`- ${item.productName} — "${item.originalText}" (reason: ${item.unmatchedReason ?? 'unknown'})`);
        }
      }
    }

    parts.push('\nPRODUCT CATALOG:');
    if (input.catalog.length === 0) {
      parts.push('(empty catalog)');
    } else {
      for (const p of input.catalog) {
        let line = `- ${p.name} — $${p.unitPrice}`;
        if (p.description) line += ' — ' + p.description;
        if (p.keywords) {
          const sanitized = p.keywords
            .replace(/[\r\n]/g, ' ')
            .replace(/[\[\]{}()]/g, '')
            .replace(/[\x00-\x1f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100);
          if (sanitized) line += ` [matches: ${sanitized}]`;
        }
        parts.push(line);
      }
    }

    parts.push('\nUSER FEEDBACK:');
    parts.push(input.feedbackText);

    return parts.join('\n');
  }

  private async parseAndValidate(raw: string, input: RevisionInput): Promise<RevisionOutput> {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed: { lineItems?: AILineItem[]; actionItems?: unknown };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn('[RevisionEngine] Failed to parse AI response');
      return {
        lineItems: input.currentLineItems,
        unresolvedItems: input.currentUnresolvedItems,
        revisionFailed: true,
      };
    }

    if (!parsed.lineItems || !Array.isArray(parsed.lineItems)) {
      console.warn('[RevisionEngine] AI response missing lineItems array');
      return {
        lineItems: input.currentLineItems,
        unresolvedItems: input.currentUnresolvedItems,
        revisionFailed: true,
      };
    }

    const actionItems = this.validateAIActionItems(parsed.actionItems);
    return this.validateAndPartition(parsed.lineItems, input.catalog, input.structuredRules, input.customerRequestText, actionItems);
  }

  private async validateAndPartition(aiItems: AILineItem[], catalog: ProductCatalogEntry[], structuredRules?: StructuredRule[], customerRequestText?: string, actionItems?: AIActionItem[]): Promise<RevisionOutput> {
    // Build a name-based lookup (case-insensitive) for catalog matching.
    // Skip empty/whitespace names; on duplicate keys keep the first entry.
    const catalogByName = new Map<string, ProductCatalogEntry>();
    for (const c of catalog) {
      const key = c.name.trim().toLowerCase();
      if (key && !catalogByName.has(key)) {
        catalogByName.set(key, c);
      }
    }

    const allItems: QuoteLineItem[] = [];

    for (const item of aiItems) {
      const score = Math.max(0, Math.min(100, Math.round(item.confidenceScore ?? 0)));
      const nameLower = (item.productName ?? '').trim().toLowerCase();
      // Skip fuzzy matching for empty/blank product names
      if (!nameLower) {
        allItems.push({
          id: crypto.randomUUID(),
          productCatalogEntryId: null,
          productName: item.productName ?? '',
          description: item.description ?? '',
          quantity: Math.max(0, item.quantity ?? 1),
          unitPrice: Math.max(0, item.unitPrice ?? 0),
          confidenceScore: Math.min(score, CONFIDENCE_THRESHOLD - 1),
          originalText: item.originalText ?? '',
          resolved: false,
          unmatchedReason: 'Empty product name',
          ruleIdsApplied: item.ruleIdsApplied ?? [],
        });
        continue;
      }

      // Try exact name match first
      let catalogEntry = catalogByName.get(nameLower);

      // Fuzzy fallback: prefer the closest length match
      if (!catalogEntry) {
        let bestMatch: ProductCatalogEntry | undefined;
        let bestDiff = Infinity;
        for (const [key, entry] of catalogByName) {
          if (key.includes(nameLower) || nameLower.includes(key)) {
            const diff = Math.abs(key.length - nameLower.length);
            if (diff < bestDiff) {
              bestMatch = entry;
              bestDiff = diff;
            }
          }
        }
        catalogEntry = bestMatch;
      }

      if (catalogEntry) {
        allItems.push({
          id: crypto.randomUUID(),
          productCatalogEntryId: catalogEntry.id,
          productName: catalogEntry.name,
          description: catalogEntry.description ?? '',
          quantity: Math.max(0, item.quantity ?? 1),
          unitPrice: Math.max(0, catalogEntry.unitPrice ?? item.unitPrice ?? 0),
          confidenceScore: score,
          originalText: item.originalText ?? '',
          resolved: score >= CONFIDENCE_THRESHOLD,
          unmatchedReason: score >= CONFIDENCE_THRESHOLD ? undefined : (item.unmatchedReason || 'Low confidence match'),
          ruleIdsApplied: item.ruleIdsApplied ?? [],
        });
      } else {
        allItems.push({
          id: crypto.randomUUID(),
          productCatalogEntryId: null,
          productName: item.productName,
          description: item.description ?? '',
          quantity: Math.max(0, item.quantity ?? 1),
          unitPrice: Math.max(0, item.unitPrice ?? 0),
          confidenceScore: Math.min(score, CONFIDENCE_THRESHOLD - 1),
          originalText: item.originalText ?? '',
          resolved: false,
          unmatchedReason: item.unmatchedReason || 'No matching product found in catalog',
          ruleIdsApplied: item.ruleIdsApplied ?? [],
        });
      }
    }

    // --- Rules Engine Integration ---
    // Convert validated AI line items to EngineLineItem format, run the
    // deterministic rules engine, then convert back for deduplication.
    let auditTrail: AuditEntry[] | undefined;
    let rulesCustomerNote: string | null = null;
    let rulesDepositSchedule: DepositSchedule | null = null;

    // Capture original unmatchedReasons before the rules engine may rebuild allItems
    const unmatchedReasonById = new Map<string, string>();
    for (const item of allItems) {
      if (item.unmatchedReason) {
        unmatchedReasonById.set(item.id, item.unmatchedReason);
      }
    }

    if (structuredRules && structuredRules.length > 0) {
      const engineLineItems: EngineLineItem[] = allItems.map((item) => ({
        id: item.id,
        productCatalogEntryId: item.productCatalogEntryId,
        productName: item.productName,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        confidenceScore: item.confidenceScore,
        originalText: item.originalText,
        ruleIdsApplied: item.ruleIdsApplied ?? [],
      }));

      const engineResult = executeRules({
        lineItems: engineLineItems,
        rules: structuredRules,
        catalog,
        customerRequestText,
      });

      auditTrail = engineResult.auditTrail;
      rulesCustomerNote = engineResult.customerNote;
      rulesDepositSchedule = engineResult.depositSchedule;

      // Process AI enrichments synchronously (extract_request_context actions)
      if (engineResult.pendingEnrichments.length > 0 && customerRequestText?.trim()) {
        const { EnrichmentService } = await import('./enrichment-service.js');
        const enrichmentService = new EnrichmentService(this.apiKey, this.apiUrl);
        const enrichedDescriptions = await enrichmentService.processEnrichments(
          engineResult.pendingEnrichments,
          customerRequestText,
          engineResult.lineItems.map(eli => ({ id: eli.id, productName: eli.productName, description: eli.description })),
        );

        // Apply enriched descriptions to engine line items before converting
        for (const eli of engineResult.lineItems) {
          const newDesc = enrichedDescriptions.get(eli.id);
          if (newDesc) {
            eli.description = newDesc;
          }
        }
      }

      // Replace allItems with engine output, preserving resolved/unresolved partitioning
      allItems.length = 0;
      for (const eli of engineResult.lineItems) {
        const resolved = eli.confidenceScore >= CONFIDENCE_THRESHOLD && eli.productCatalogEntryId !== null;
        allItems.push({
          id: eli.id,
          productCatalogEntryId: eli.productCatalogEntryId,
          productName: eli.productName,
          description: eli.description,
          quantity: Math.max(0, eli.quantity),
          unitPrice: Math.max(0, eli.unitPrice),
          confidenceScore: eli.confidenceScore,
          originalText: eli.originalText,
          resolved,
          unmatchedReason: resolved ? undefined : (unmatchedReasonById.get(eli.id) ?? 'Low confidence match'),
          ruleIdsApplied: eli.ruleIdsApplied,
        });
      }
    }

    // Deduplicate BEFORE partitioning so duplicates split across the
    // confidence threshold (one resolved, one unresolved) are caught.
    const dedupedItems = deduplicateLineItems(allItems);

    // Always sort by catalog sort order. Rule positioning intent (placeAfter/
    // placeBefore) is already reflected in the catalog sort_order values.
    const finalItems = sortLineItemsByCatalog(dedupedItems, catalog);
    const lineItems = finalItems.filter((i) => i.resolved);
    const unresolvedItems = finalItems.filter((i) => !i.resolved);

    return {
      lineItems,
      unresolvedItems,
      actionItems: actionItems && actionItems.length > 0 ? actionItems : undefined,
      rulesEngineAuditTrail: auditTrail && auditTrail.length > 0 ? auditTrail : undefined,
      customerNote: rulesCustomerNote,
      depositSchedule: rulesDepositSchedule,
    };
  }

  private validateAIActionItems(raw: unknown): AIActionItem[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (item): item is AIActionItem =>
          item != null &&
          typeof item === 'object' &&
          typeof (item as AIActionItem).lineItemProductName === 'string' &&
          (item as AIActionItem).lineItemProductName.trim() !== '' &&
          typeof (item as AIActionItem).description === 'string' &&
          (item as AIActionItem).description.trim() !== '',
      )
      .map(item => ({
        lineItemProductName: item.lineItemProductName.trim(),
        description: item.description.trim(),
      }));
  }
}
