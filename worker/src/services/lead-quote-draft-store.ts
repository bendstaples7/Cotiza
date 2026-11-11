import type {
  ActionItem,
  LeadQuoteDraft,
  QuoteDraft,
  QuoteLineItem,
} from 'shared';
import { QuoteDraftService } from './quote-draft-service.js';

/** Everything the stored draft needs that the generator output does not carry. */
export interface LeadQuoteDraftStoreContext {
  userId: string;
  requestText: string;
  clientName?: string | null;
  propertyAddress?: string | null;
  now: Date;
}

/**
 * Pure mapping from the committed generator output to the existing QuoteDraft
 * shape, so `QuoteDraftService.save` persists it without any schema change.
 */
export function toQuoteDraft(lead: LeadQuoteDraft, ctx: LeadQuoteDraftStoreContext): QuoteDraft {
  const id = crypto.randomUUID();
  const lineItems: QuoteLineItem[] = [];
  const unresolvedItems: QuoteLineItem[] = [];

  for (const line of lead.lineItems) {
    const base = {
      id: crypto.randomUUID(),
      productCatalogEntryId: line.productId ?? null,
      productName: line.name,
      description: line.description,
      quantity: line.qty,
      originalText: line.description,
    };

    if (line.unitPrice !== null) {
      lineItems.push({
        ...base,
        unitPrice: line.unitPrice,
        confidenceScore: line.productId ? 100 : 85,
        resolved: true,
      });
    } else {
      unresolvedItems.push({
        ...base,
        unitPrice: 0,
        confidenceScore: 0,
        resolved: false,
        unmatchedReason: 'No catalog price',
      });
    }
  }

  for (const scope of lead.scopeCheck) {
    if (!scope.requested || scope.covered) continue;
    const text = scope.note ?? scope.scope;
    unresolvedItems.push({
      id: crypto.randomUUID(),
      productCatalogEntryId: null,
      productName: scope.scope,
      description: text,
      quantity: 1,
      unitPrice: 0,
      confidenceScore: 0,
      originalText: text,
      resolved: false,
      unmatchedReason: 'Requested but not in the quote',
    });
  }

  const actionItems: ActionItem[] = lead.openRisks.map((risk) => ({
    id: crypto.randomUUID(),
    quoteDraftId: id,
    lineItemId: '',
    description: risk.detail,
    completed: false,
  }));

  return {
    id,
    draftNumber: 0,
    userId: ctx.userId,
    customerRequestText: ctx.requestText,
    selectedTemplateId: null,
    selectedTemplateName: null,
    lineItems,
    unresolvedItems,
    jobberRequestId: lead.requestId,
    clientName: ctx.clientName ?? null,
    propertyAddress: ctx.propertyAddress ?? null,
    status: 'draft',
    actionItems,
    customerNote: lead.customerNote,
    depositSchedule: { label: 'Standard Deposit', milestones: lead.milestones },
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

/** Map the generated lead draft and store it in the existing draft tables. */
export async function storeLeadDraft(
  db: D1Database,
  lead: LeadQuoteDraft,
  ctx: LeadQuoteDraftStoreContext,
): Promise<QuoteDraft> {
  return new QuoteDraftService(db).save(toQuoteDraft(lead, ctx));
}
