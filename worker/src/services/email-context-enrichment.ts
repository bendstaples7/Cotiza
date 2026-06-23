import { extractCustomerEmailFromRequestBody } from 'shared';
import { EmailContextService } from './email-context-service.js';
import { loadBestWebhookRow } from './jobber-request-enrichment.js';

export interface EmailEnrichmentConfig {
  gmailClientId?: string;
  gmailClientSecret?: string;
  gmailRefreshToken?: string;
}

/** Fetch Gmail thread context for a known customer email (graceful degradation). */
export async function fetchEmailContextForCustomerEmail(
  customerEmail: string,
  emailConfig: EmailEnrichmentConfig,
  timeoutMs = 6_000,
): Promise<string> {
  const emailService = new EmailContextService(
    emailConfig.gmailClientId,
    emailConfig.gmailClientSecret,
    emailConfig.gmailRefreshToken,
  );
  if (!emailService.isAvailable() || !customerEmail.trim()) {
    return '';
  }

  return Promise.race<string>([
    emailService.fetchContext(customerEmail),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), timeoutMs)),
  ]);
}

/** Resolve customer email from a Jobber request row and fetch Gmail context. */
export async function fetchEmailContextForJobberRequest(
  db: D1Database,
  jobberRequestId: string,
  emailConfig: EmailEnrichmentConfig,
  timeoutMs = 6_000,
): Promise<string> {
  const jobberRow = await loadBestWebhookRow(db, jobberRequestId);
  const customerEmail = jobberRow?.request_body
    ? extractCustomerEmailFromRequestBody(jobberRow.request_body)
    : null;

  if (!customerEmail) return '';

  return fetchEmailContextForCustomerEmail(customerEmail, emailConfig, timeoutMs);
}

/** Prepend email context block to customer text when not already present. */
export function prependEmailContextToCustomerText(
  customerText: string,
  emailContext: string,
): string {
  const trimmedContext = emailContext.trim();
  if (!trimmedContext) return customerText;
  if (customerText.includes('--- Email Conversation Context ---')) return customerText;
  return trimmedContext + '\n\n' + customerText;
}
