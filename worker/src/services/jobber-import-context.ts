import { extractCustomerEmailFromRequestBody } from 'shared';
import { EmailContextService } from './email-context-service.js';
import { loadBestWebhookRow, resolveJobberRequestForGenerate } from './jobber-request-enrichment.js';
import type { JobberIntegration } from './jobber-integration.js';

export interface JobberImportEmailConfig {
  gmailClientId?: string;
  gmailClientSecret?: string;
  gmailRefreshToken?: string;
}

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
      const jobberRow = await loadBestWebhookRow(db, linkedRequestId);
      const customerEmail = jobberRow?.request_body
        ? extractCustomerEmailFromRequestBody(jobberRow.request_body)
        : null;

      if (customerEmail) {
        const emailService = new EmailContextService(
          emailConfig.gmailClientId,
          emailConfig.gmailClientSecret,
          emailConfig.gmailRefreshToken,
        );
        if (emailService.isAvailable()) {
          const emailContext = await Promise.race<string>([
            emailService.fetchContext(customerEmail),
            new Promise<string>((resolve) => setTimeout(() => resolve(''), 6000)),
          ]);
          if (emailContext) {
            customerText = emailContext + '\n\n' + customerText;
          }
        }
      }
    }
  } catch {
    // Graceful degradation — email context failure must not block import scoring
  }

  return customerText;
}
