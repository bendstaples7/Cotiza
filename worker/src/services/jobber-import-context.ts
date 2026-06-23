import { resolveJobberRequestForGenerate } from './jobber-request-enrichment.js';
import type { JobberIntegration } from './jobber-integration.js';
import {
  fetchEmailContextForJobberRequest,
  prependEmailContextToCustomerText,
  type EmailEnrichmentConfig,
} from './email-context-enrichment.js';

export type JobberImportEmailConfig = EmailEnrichmentConfig;

/**
 * Build enriched customer context for import scoring — mirrors the generate-quote
 * path (Jobber request resolution + optional Gmail thread context).
 */
export async function buildJobberImportCustomerContext(
  db: D1Database,
  linkedRequestId: string | null,
  baseCustomerText: string,
  jobberIntegration: JobberIntegration,
  emailConfig?: JobberImportEmailConfig,
): Promise<string> {
  let customerText = baseCustomerText;

  if (linkedRequestId) {
    const resolved = await resolveJobberRequestForGenerate(db, linkedRequestId, jobberIntegration);
    if (resolved?.serviceDescription?.trim()) {
      customerText = resolved.serviceDescription;
    }
  }

  try {
    if (linkedRequestId && emailConfig) {
      const emailContext = await fetchEmailContextForJobberRequest(db, linkedRequestId, emailConfig);
      if (emailContext) {
        customerText = prependEmailContextToCustomerText(customerText, emailContext);
      }
    }
  } catch (err) {
    console.warn(
      '[buildJobberImportCustomerContext] Email enrichment failed:',
      err instanceof Error ? err.message : err,
    );
  }

  return customerText;
}
