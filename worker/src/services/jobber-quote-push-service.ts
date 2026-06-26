import type { QuoteDraft, DepositSchedule, QuoteLineItem } from 'shared';
import { PlatformError } from '../errors/index.js';
import type { JobberIntegration } from './jobber-integration.js';

/**
 * Assembles the Jobber quote message from its three optional segments:
 *   1. customerNote (if non-null and non-empty)
 *   2. deposit schedule text (if depositSchedule is non-null and has at least one milestone)
 *   3. unresolved items text (if unresolvedItems is non-empty)
 *
 * Present segments are joined with `\n\n`. Absent segments are omitted entirely.
 * Returns `undefined` when no segments are present.
 *
 * Milestone percentages are rendered as whole integers via Math.round.
 */
export function buildJobberMessage(
  customerNote: string | null,
  depositSchedule: DepositSchedule | null,
  unresolvedItems: QuoteLineItem[],
): string | undefined {
  const messageParts: string[] = [];

  if (customerNote?.trim()) {
    messageParts.push(customerNote.trim());
  }

  if (depositSchedule && depositSchedule.milestones.length > 0) {
    const milestoneLines = depositSchedule.milestones.map(
      (m) => `• ${Math.round(m.percentage)}% — ${m.description}`,
    );
    messageParts.push(`${depositSchedule.label}\n${milestoneLines.join('\n')}`);
  }

  if (unresolvedItems && unresolvedItems.length > 0) {
    const unresolvedTexts = unresolvedItems.map((item) => `• ${item.originalText}`);
    messageParts.push(`Unresolved items from original request:\n${unresolvedTexts.join('\n')}`);
  }

  return messageParts.length > 0 ? messageParts.join('\n\n') : undefined;
}

export interface PushResult {
  jobberQuoteId: string;
  jobberQuoteNumber: string;
  jobberQuoteWebUri: string;
}

const FETCH_REQUEST_CLIENT_QUERY = `
  query FetchRequestClient($id: EncodedId!) {
    request(id: $id) {
      id
      client {
        id
        clientProperties(first: 1) {
          nodes {
            id
          }
        }
      }
    }
  }
`;

const QUOTE_CREATE_MUTATION = `
  mutation CreateQuote($attributes: QuoteCreateAttributes!) {
    quoteCreate(attributes: $attributes) {
      quote {
        id
        quoteNumber
        quoteStatus
        jobberWebUri
      }
      userErrors {
        message
        path
      }
    }
  }
`;

const QUOTE_EDIT_MUTATION = `
  mutation EditQuote($quoteId: EncodedId!, $attributes: QuoteEditAttributes!) {
    quoteEdit(quoteId: $quoteId, attributes: $attributes) {
      quote {
        id
        quoteNumber
        quoteStatus
        jobberWebUri
      }
      userErrors {
        message
        path
      }
    }
  }
`;

const QUOTE_EDIT_LINE_ITEMS_MUTATION = `
  mutation EditQuoteLineItems($quoteId: EncodedId!, $lineItems: [QuoteEditLineItemAttributes!]!) {
    quoteEditLineItems(quoteId: $quoteId, lineItems: $lineItems) {
      quote {
        id
        quoteNumber
        quoteStatus
        jobberWebUri
      }
      userErrors {
        message
        path
      }
    }
  }
`;

export class JobberQuotePushService {
  private readonly db: D1Database;
  private readonly jobberIntegration: JobberIntegration;

  constructor(db: D1Database, jobberIntegration: JobberIntegration) {
    this.db = db;
    this.jobberIntegration = jobberIntegration;
  }

  /**
   * Push a quote draft to Jobber. Resolves the customer, builds the mutation,
   * executes it, and persists the result back to D1.
   * Throws PlatformError on validation or API failures.
   */
  async pushToJobber(draft: QuoteDraft): Promise<PushResult> {
    if (!draft.jobberRequestId) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuotePushService',
        operation: 'pushToJobber',
        description: 'A Jobber request must be linked to this draft before pushing to Jobber.',
        recommendedActions: ['Generate the quote from a Jobber customer request'],
        statusCode: 400,
      });
    }

    // Step 1: Resolve the customer ID and property ID from the linked request
    const { clientId, propertyId } = await this.resolveCustomerAndProperty(draft.jobberRequestId);

    // Step 2: Build the quoteCreate mutation input
    const { query, variables } = this.buildQuoteCreateInput(draft, clientId, propertyId);

    // Step 3: Execute the mutation
    const response = await this.jobberIntegration.graphqlRequest<{
      quoteCreate: {
        quote: { id: string; quoteNumber: string; quoteStatus: string; jobberWebUri: string } | null;
        userErrors: Array<{ message: string; path: string[] }>;
      };
    }>(query, variables);

    // Step 4: Handle userErrors
    if (response.quoteCreate.userErrors && response.quoteCreate.userErrors.length > 0) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuotePushService',
        operation: 'pushToJobber',
        description: `Jobber rejected the quote: ${response.quoteCreate.userErrors[0].message}`,
        recommendedActions: ['Review the error details and adjust the quote draft'],
        statusCode: 422,
      });
    }

    const quote = response.quoteCreate.quote;
    if (!quote) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuotePushService',
        operation: 'pushToJobber',
        description: 'Jobber returned no quote in the response.',
        recommendedActions: ['Try again'],
        statusCode: 502,
      });
    }

    const result: PushResult = {
      jobberQuoteId: quote.id,
      jobberQuoteNumber: quote.quoteNumber,
      jobberQuoteWebUri: quote.jobberWebUri,
    };

    // Step 5: Persist the result back to D1. The remote quote already exists at
    // this point, so a D1 failure must NOT surface as a generic push failure —
    // that would invite a retry and create a DUPLICATE Jobber quote. Surface a
    // specific error that tells the user the quote was created and not to retry.
    try {
      await this.persistPushResult(draft.id, result.jobberQuoteId, result.jobberQuoteNumber, result.jobberQuoteWebUri);
    } catch (err) {
      console.error(
        `[JobberQuotePushService] Quote ${result.jobberQuoteNumber} (${result.jobberQuoteId}) was created in Jobber but persisting to draft ${draft.id} failed:`,
        err,
      );
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuotePushService',
        operation: 'pushToJobber',
        description: `Quote ${result.jobberQuoteNumber} was created in Jobber, but linking it back to this draft failed. Do NOT push again or you will create a duplicate.`,
        recommendedActions: [
          `Open quote ${result.jobberQuoteNumber} in Jobber to confirm it exists`,
          'Manually reconcile the draft or contact support before retrying',
        ],
        statusCode: 500,
      });
    }

    return result;
  }

  /**
   * Resolve the Jobber client ID and property ID from a request ID.
   * Property ID is required by the Jobber quoteCreate mutation.
   */
  private async resolveCustomerAndProperty(jobberRequestId: string): Promise<{ clientId: string; propertyId: string }> {
    const response = await this.jobberIntegration.graphqlRequest<{
      request: {
        id: string;
        client: {
          id: string;
          clientProperties: { nodes: Array<{ id: string }> };
        } | null;
      } | null;
    }>(FETCH_REQUEST_CLIENT_QUERY, { id: jobberRequestId });

    if (!response.request?.client?.id) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuotePushService',
        operation: 'resolveCustomerAndProperty',
        description: 'The customer request does not have a linked client in Jobber. Cannot create a quote without a customer.',
        recommendedActions: ['Link a client to the request in Jobber, then retry'],
        statusCode: 422,
      });
    }

    const clientId = response.request.client.id;
    const propertyId = response.request.client.clientProperties?.nodes?.[0]?.id;

    if (!propertyId) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuotePushService',
        operation: 'resolveCustomerAndProperty',
        description: 'The client does not have a property in Jobber. A property is required to create a quote.',
        recommendedActions: ['Add a property to the client in Jobber, then retry'],
        statusCode: 422,
      });
    }

    return { clientId, propertyId };
  }

  /**
   * Build the quoteCreate mutation input from a draft and client ID.
   */
  private buildQuoteCreateInput(
    draft: QuoteDraft,
    clientId: string,
    propertyId: string,
  ): { query: string; variables: Record<string, unknown> } {
    const lineItems = draft.lineItems.map((item) => {
      const mapped: Record<string, unknown> = {
        name: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        saveToProductsAndServices: false,
      };
      if (item.description) {
        mapped.description = item.description;
      }
      return mapped;
    });

    // Build title with zero-padded draft number
    const paddedNumber = String(draft.draftNumber ?? 0).padStart(3, '0');
    const title = `Draft D-${paddedNumber}`;

    // Build message in order: (1) customerNote, (2) deposit schedule, (3) unresolved items
    const message = buildJobberMessage(draft.customerNote, draft.depositSchedule, draft.unresolvedItems ?? []);

    const input: Record<string, unknown> = {
      clientId,
      propertyId,
      title,
      lineItems,
    };

    // Link to the originating Jobber request
    if (draft.jobberRequestId) {
      input.requestId = draft.jobberRequestId;
    }

    if (message) {
      input.message = message;
    }

    return {
      query: QUOTE_CREATE_MUTATION,
      variables: { attributes: input },
    };
  }

  /**
   * Persist the Jobber quote identifiers and update status to 'finalized'.
   */
  private async persistPushResult(
    draftId: string,
    jobberQuoteId: string,
    jobberQuoteNumber: string,
    jobberQuoteWebUri: string,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE quote_drafts SET jobber_quote_id = ?, jobber_quote_number = ?, jobber_quote_web_uri = ?, status = 'finalized', updated_at = datetime('now') WHERE id = ?`
    ).bind(jobberQuoteId, jobberQuoteNumber, jobberQuoteWebUri, draftId).run();
  }

  /**
   * Update an existing Jobber quote (one that was already pushed or imported).
   * Validates that the draft has a linked Jobber quote ID, then updates the
   * quote header (title, message) and any line items that have a jobberLineItemId.
   * Does NOT persist — the quote ID is already known.
   */
  async pushUpdateToJobber(draft: QuoteDraft): Promise<PushResult> {
    if (!draft.jobberQuoteId) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuotePushService',
        operation: 'pushUpdateToJobber',
        description:
          'This draft has no linked Jobber quote to update. Use pushToJobber to create a new quote instead.',
        recommendedActions: [
          'Import a Jobber quote first, then use push-update to push improvements',
        ],
        statusCode: 400,
      });
    }

    // Step 1: Build the quoteEdit mutation input
    const paddedNumber = String(draft.draftNumber ?? 0).padStart(3, '0');
    const title = `Draft D-${paddedNumber}`;
    const message = buildJobberMessage(
      draft.customerNote,
      draft.depositSchedule,
      draft.unresolvedItems ?? [],
    );

    const attributes: Record<string, unknown> = {
      title,
    };
    if (message) {
      attributes.message = message;
    }

    // Step 2: Execute the quoteEdit mutation
    const editResponse = await this.jobberIntegration.graphqlRequest<{
      quoteEdit: {
        quote: {
          id: string;
          quoteNumber: string;
          quoteStatus: string;
          jobberWebUri: string;
        } | null;
        userErrors: Array<{ message: string; path: string[] }>;
      };
    }>(QUOTE_EDIT_MUTATION, {
      quoteId: draft.jobberQuoteId,
      attributes,
    });

    if (
      editResponse.quoteEdit.userErrors &&
      editResponse.quoteEdit.userErrors.length > 0
    ) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuotePushService',
        operation: 'pushUpdateToJobber',
        description: `Jobber rejected the quote update: ${editResponse.quoteEdit.userErrors[0].message}`,
        recommendedActions: [
          'Review the error details and adjust the quote draft',
        ],
        statusCode: 422,
      });
    }

    const quote = editResponse.quoteEdit.quote;
    if (!quote) {
      throw new PlatformError({
        severity: 'error',
        component: 'JobberQuotePushService',
        operation: 'pushUpdateToJobber',
        description: 'Jobber returned no quote in the response.',
        recommendedActions: ['Try again'],
        statusCode: 502,
      });
    }

    // Step 3: Update line items that have jobberLineItemId
    const lineItemsWithIds = draft.lineItems.filter(
      (item) => item.jobberLineItemId,
    );
    if (lineItemsWithIds.length > 0) {
      const lineItemInputs = lineItemsWithIds.map((item) => ({
        id: item.jobberLineItemId,
        name: item.productName,
        quantity: item.quantity,
        unitPrice: { amount: item.unitPrice },
        ...(item.description ? { description: item.description } : {}),
      }));

      const lineItemResponse = await this.jobberIntegration.graphqlRequest<{
        quoteEditLineItems: {
          quote: {
            id: string;
            quoteNumber: string;
            quoteStatus: string;
            jobberWebUri: string;
          } | null;
          userErrors: Array<{ message: string; path: string[] }>;
        };
      }>(QUOTE_EDIT_LINE_ITEMS_MUTATION, {
        quoteId: draft.jobberQuoteId,
        lineItems: lineItemInputs,
      });

      if (lineItemResponse.quoteEditLineItems.userErrors?.length > 0) {
        // Log but don't block — header update succeeded
        console.warn(
          `Line item update had errors: ${lineItemResponse.quoteEditLineItems.userErrors.map((e) => e.message).join(', ')}`,
        );
      }
    }

    return {
      jobberQuoteId: quote.id,
      jobberQuoteNumber: quote.quoteNumber,
      jobberQuoteWebUri: quote.jobberWebUri,
    };
  }
}
