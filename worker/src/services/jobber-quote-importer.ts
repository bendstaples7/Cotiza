import { PlatformError } from '../errors/index.js';
import type { QuoteDraft, QuoteLineItem } from 'shared';
import { QuoteDraftService } from './quote-draft-service.js';
import type { JobberIntegration } from './jobber-integration.js';
import { ActivityLogService } from './activity-log-service.js';
import { isActiveJobberQuoteStatus } from './jobber-quote-status.js';

// ── Exported types ──────────────────────────────────────────────────────

export interface ImportableQuoteLineItem {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
}

export interface ImportableQuoteClient {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

export interface ImportableQuoteProperty {
  address?: string;
}

export interface ImportableQuoteRequest {
  id: string;
}

export interface ImportableQuote {
  id: string;
  quoteNumber: string;
  title: string | null;
  message: string | null;
  quoteStatus: string;
  jobberWebUri: string | null;
  createdAt: string;
  lineItems: ImportableQuoteLineItem[];
  client: ImportableQuoteClient | null;
  property: ImportableQuoteProperty | null;
  request?: ImportableQuoteRequest | null;
}

export interface ImportQuoteResult {
  draft: QuoteDraft;
  warnings: string[];
}

export interface ImportQuoteScoringContext {
  lineItems: QuoteLineItem[];
  customerRequestText: string;
  linkedRequestId: string | null;
}

export interface ImportQuoteOptions {
  scoreImportedLineItems?: (
    ctx: ImportQuoteScoringContext,
  ) => Promise<{
    lineItems: QuoteLineItem[];
    unresolvedItems: QuoteLineItem[];
    lowConfidenceCount: number;
  }>;
}

// ── GraphQL queries ─────────────────────────────────────────────────────

const IMPORTABLE_QUOTES_QUERY = `
  query FetchImportableQuotes($first: Int!, $after: String) {
    quotes(first: $first, after: $after) {
      edges {
        node {
          id
          quoteNumber
          title
          message
          quoteStatus
          jobberWebUri
          createdAt
          client {
            id
            firstName
            lastName
            companyName
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const FETCH_QUOTE_BY_ID_QUERY = `
  query FetchQuoteById($id: EncodedId!) {
    quote(id: $id) {
      id
      quoteNumber
      title
      message
      quoteStatus
      jobberWebUri
      createdAt
      lineItems {
        nodes {
          id
          name
          description
          quantity
          unitPrice
        }
      }
      client {
        id
        firstName
        lastName
        companyName
      }
      property {
        address {
          street1
          street2
          city
          province
          postalCode
        }
      }
      request {
        id
      }
      amounts {
        depositAmount
        total
      }
    }
  }
`;

const REQUEST_QUOTES_QUERY = `
  query RequestQuotes($id: EncodedId!) {
    request(id: $id) {
      quotes(first: 50) {
        nodes {
          id
          quoteNumber
          title
          quoteStatus
          jobberWebUri
          createdAt
        }
      }
    }
  }
`;

// ── Service ─────────────────────────────────────────────────────────────

export class JobberQuoteImportService {
  private readonly db: D1Database;
  private readonly quoteDraftService: QuoteDraftService;
  private readonly jobberIntegration: JobberIntegration;
  private readonly activityLog: ActivityLogService;

  constructor(
    db: D1Database,
    quoteDraftService: QuoteDraftService,
    jobberIntegration: JobberIntegration,
    activityLog: ActivityLogService,
  ) {
    this.db = db;
    this.quoteDraftService = quoteDraftService;
    this.jobberIntegration = jobberIntegration;
    this.activityLog = activityLog;
  }

  /**
   * Fetch all importable quotes from Jobber (draft + sent status).
   * Returns up to 200 quotes total, paginated 25 at a time.
   */
  async fetchImportableQuotes(): Promise<ImportableQuote[]> {
    const allQuotes: ImportableQuote[] = [];
    let after: string | null = null;
    const PAGE_SIZE = 10;
    const MAX_QUOTES = 200;

    do {
      const data = await this.jobberIntegration.graphqlRequest<Record<string, unknown>>(
        IMPORTABLE_QUOTES_QUERY, { first: PAGE_SIZE, after }
      );

      const raw = data?.quotes as {
        edges: Array<{ node: ImportableQuote }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      } | undefined;

      if (!raw || !raw.edges) break;
      const connection = raw;

      for (const edge of connection.edges) {
        const rawNode = edge.node as any;
        const node: ImportableQuote = {
          ...rawNode,
          lineItems: rawNode.lineItems?.nodes ?? [],
        };
        if (isActiveJobberQuoteStatus(node.quoteStatus)) {
          allQuotes.push(node);
        }
      }

      if (allQuotes.length >= MAX_QUOTES) break;

      if (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor) {
        after = connection.pageInfo.endCursor;
      } else {
        break;
      }
    } while (true);

    return allQuotes;
  }

  /**
   * Fetch active in-progress quotes linked to a Jobber request (lightweight, no line items).
   */
  async fetchQuotesForRequest(jobberRequestId: string, signal?: AbortSignal): Promise<ImportableQuote[]> {
    const data = await this.jobberIntegration.graphqlRequest<Record<string, unknown>>(
      REQUEST_QUOTES_QUERY,
      { id: jobberRequestId },
      { signal },
    );

    const nodes = (data?.request as { quotes?: { nodes?: ImportableQuote[] } } | undefined)
      ?.quotes?.nodes ?? [];

    return nodes
      .filter((node) => isActiveJobberQuoteStatus(node.quoteStatus))
      .map((node) => ({
        ...node,
        message: null,
        lineItems: [],
        client: null,
        property: null,
      }));
  }

  /**
   * Import a single Jobber quote as a Cotiza quote draft.
   *
   * Validates: quote must not already be imported.
   * Status handling: in-progress statuses are preferred; non-active statuses are imported with a warning.
   * Transforms: creates a quote draft with line items, customer text, and
   * links back to the original Jobber quote.
   */
  async importQuote(
    jobberQuoteId: string,
    userId: string,
    options?: ImportQuoteOptions,
  ): Promise<ImportQuoteResult> {
    const warnings: string[] = [];

    // 1. Check if already imported
    const existing = await this.db.prepare(
      'SELECT id FROM quote_drafts WHERE jobber_quote_id = ? AND user_id = ? LIMIT 1'
    ).bind(jobberQuoteId, userId).first<{ id: string }>();

    if (existing) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuoteImportService',
        operation: 'importQuote',
        description: 'This Jobber quote has already been imported as a draft.',
        recommendedActions: [
          `View existing draft at /quotes/drafts/${existing.id}`,
        ],
        statusCode: 409,
      });
    }

    // 2. Fetch the quote from Jobber
    const data: {
      quote: ImportableQuote | null;
    } | null = await this.jobberIntegration.graphqlRequest<{
      quote: ImportableQuote | null;
    }>(FETCH_QUOTE_BY_ID_QUERY, { id: jobberQuoteId });

    const rawQuote = (data?.quote as any);
    const quote = rawQuote ? {
      ...rawQuote,
      lineItems: (rawQuote.lineItems?.nodes ?? []) as ImportableQuoteLineItem[],
      request: rawQuote.request ?? null,
    } as ImportableQuote : null;
    if (!quote) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuoteImportService',
        operation: 'importQuote',
        description: `Jobber quote with ID "${jobberQuoteId}" was not found.`,
        recommendedActions: ['Verify the quote exists in Jobber and try again.'],
        statusCode: 404,
      });
    }

    // 3. Validate status
    if (!isActiveJobberQuoteStatus(quote.quoteStatus)) {
      warnings.push(
        `Quote status is "${quote.quoteStatus}". Only in-progress quotes are importable. The draft will be created but may need manual review.`,
      );
    }

    const linkedRequestId = quote.request?.id?.trim() || null;

    // 4. Build customer request text from title + message
    const titleText = quote.title?.trim() || '';
    const messageText = quote.message?.trim() || '';

    let customerRequestText: string;
    let customerNote: string | null = null;

    if (titleText && messageText) {
      // Use title as the primary request text, message as the customer note
      customerRequestText = titleText;
      customerNote = messageText;
    } else if (titleText) {
      customerRequestText = titleText;
    } else if (messageText) {
      customerRequestText = messageText;
    } else {
      customerRequestText = `Jobber Quote #${quote.quoteNumber}`;
      warnings.push('Quote has no title or message. A placeholder was used as customer request text.');
    }

    // 5. Build client name for display
    let clientName: string | null = null;
    if (quote.client) {
      const { firstName, lastName, companyName } = quote.client;
      if (companyName) {
        clientName = companyName;
      } else if (firstName || lastName) {
        clientName = `${firstName || ''} ${lastName || ''}`.trim() || null;
      } else {
        clientName = null;
      }
    }

    // 6. Build line items from Jobber line items (confidence scored below when configured)
    let lineItems: QuoteLineItem[] = (quote.lineItems || []).map((item) => ({
      id: crypto.randomUUID(),
      jobberLineItemId: item.id || null,
      productCatalogEntryId: null,
      productName: item.name,
      description: item.description || '',
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      confidenceScore: 0,
      originalText: item.name,
      resolved: false,
    }));

    let unresolvedItems: QuoteLineItem[] = [];

    if (options?.scoreImportedLineItems && lineItems.length > 0) {
      const scored = await options.scoreImportedLineItems({
        lineItems,
        customerRequestText,
        linkedRequestId,
      });
      lineItems = scored.lineItems;
      unresolvedItems = scored.unresolvedItems;
      if (scored.lowConfidenceCount > 0) {
        warnings.push(
          `${scored.lowConfidenceCount} line item(s) scored below confidence threshold and were moved to review.`,
        );
      }
    } else if (lineItems.length > 0) {
      lineItems = lineItems.map((item) => ({
        ...item,
        confidenceScore: 100,
        resolved: true,
      }));
    }

    // Warnings for empty line items
    if (lineItems.length === 0 && unresolvedItems.length === 0) {
      warnings.push('Quote has no line items. An empty draft will be created.');
    }

    // 7. Build property address
    let propertyAddress: string | null = null;
    const rawAddr = (quote.property as any)?.address;
    if (rawAddr) {
      const parts = [rawAddr.street1, rawAddr.street2, rawAddr.city, rawAddr.province, rawAddr.postalCode]
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
      if (parts.length > 0) {
        propertyAddress = parts.join(', ');
      }
    }

    // 8. Build deposit schedule from Jobber deposit amount
    let depositSchedule = null;
    const rawAmounts = (rawQuote as any)?.amounts;
    if (rawAmounts && rawAmounts.depositAmount > 0 && rawAmounts.total > 0) {
      const depositPct = Math.round((rawAmounts.depositAmount / rawAmounts.total) * 100);
      const remainingPct = 100 - depositPct;
      depositSchedule = {
        label: 'Jobber Deposit Schedule',
        milestones: [
          { description: 'Deposit due upon acceptance', percentage: depositPct },
          ...(remainingPct > 0 ? [{ description: 'Balance due upon completion', percentage: remainingPct }] : []),
        ],
      };
    }

    // 9. Create the draft
    // Map the Jobber createdAt to first_draft_created_at for deathclock
    const jobberCreatedAt = quote.createdAt;

    const draftPayload: QuoteDraft = {
      id: crypto.randomUUID(),
      userId,
      draftNumber: 0, // Will be assigned by the DB
      customerRequestText,
      customerNote,
      selectedTemplateId: null,
      selectedTemplateName: null,
      lineItems,
      unresolvedItems,
      jobberRequestId: linkedRequestId,
      manualRequestId: null,
      clientName,
      propertyAddress,
      jobberQuoteId: quote.id,
      jobberQuoteNumber: quote.quoteNumber,
      jobberQuoteWebUri: quote.jobberWebUri || null,
      status: 'draft',
      actionItems: [],
      depositSchedule: depositSchedule as any,
      sqftResolution: null,
      spaceContext: null,
      generationTrace: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const savedDraft = await this.quoteDraftService.save(draftPayload);

    // 9. Set first_draft_created_at to Jobber's createdAt for deathclock accuracy
    // The quoteDraftService.save() sets first_draft_created_at to datetime('now')
    // via its deathclock logic. We override it here to use the Jobber quote's
    // creation timestamp so the deathclock reflects the actual request age.
    await this.db.prepare(
      'UPDATE quote_drafts SET first_draft_created_at = ? WHERE id = ? AND first_draft_created_at IS NOT NULL'
    ).bind(jobberCreatedAt, savedDraft.id).run();

    // If first_draft_created_at was null (no manualRequestId or jobberRequestId),
    // we need to set it directly
    if (!savedDraft.manualRequestId && !savedDraft.jobberRequestId) {
      await this.db.prepare(
        'UPDATE quote_drafts SET first_draft_created_at = ? WHERE id = ?'
      ).bind(jobberCreatedAt, savedDraft.id).run();
    }

    // Log the import
    await this.activityLog.log({
      userId,
      component: 'JobberQuoteImportService',
      operation: 'importQuote',
      severity: 'info',
      description: `Imported Jobber quote #${quote.quoteNumber} as draft ${savedDraft.draftNumber}${warnings.length > 0 ? ` (${warnings.length} warnings)` : ''}`,
    });

    // Re-fetch the saved draft to get the latest state
    const finalDraft = await this.quoteDraftService.getById(savedDraft.id, userId);

    return { draft: finalDraft, warnings };
  }
}