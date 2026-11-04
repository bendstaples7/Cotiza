/**
 * read_client_history: one Jobber client's past work (jobs, invoices, quotes, requests).
 *
 * Used by quote reviews to tell whether a lead is a past customer, which changes send routing.
 * Each section is read with its own query so one unreadable section never hides the others,
 * and a failed section is reported as failed, never as "no history". Read-only.
 */

export const CLIENT_HISTORY_LIMIT = 50;

const PAGE = `(first: ${CLIENT_HISTORY_LIMIT})`;
const PAGE_INFO = 'pageInfo { hasNextPage }';

export const CLIENT_HISTORY_QUERIES = {
  client: `query AssistantClient($id: EncodedId!) {
  client(id: $id) { id firstName lastName companyName createdAt }
}`,
  jobs: `query AssistantClientJobs($id: EncodedId!) {
  client(id: $id) { id jobs${PAGE} {
    nodes { id jobNumber title jobStatus startAt endAt completedAt createdAt total jobberWebUri quote { id quoteNumber } }
    ${PAGE_INFO}
  } }
}`,
  invoices: `query AssistantClientInvoices($id: EncodedId!) {
  client(id: $id) { id invoices${PAGE} {
    nodes { id invoiceNumber invoiceStatus subject issuedDate jobberWebUri }
    ${PAGE_INFO}
  } }
}`,
  quotes: `query AssistantClientQuotes($id: EncodedId!) {
  client(id: $id) { id quotes${PAGE} {
    nodes { id quoteNumber title quoteStatus createdAt jobberWebUri }
    ${PAGE_INFO}
  } }
}`,
  requests: `query AssistantClientRequests($id: EncodedId!) {
  client(id: $id) { id requests${PAGE} {
    nodes { id title requestStatus createdAt }
    ${PAGE_INFO}
  } }
}`,
} as const;

export type HistorySectionName = 'jobs' | 'invoices' | 'quotes' | 'requests';

export type HistorySection =
  | { outcome: 'ok'; items: Array<Record<string, unknown>>; truncated: boolean }
  | { outcome: 'failed'; items: []; failure: string };

const WON_QUOTE = new Set(['approved', 'converted']);

/**
 * Decide whether the client is an existing customer: has booked or completed work with Chicago
 * Reno (any job, a non-draft invoice, or an approved/converted quote), ignoring the quote under
 * review and any job made from it. "unknown" when a section that could prove it failed or was
 * cut off before anything was found.
 */
export function summarizeClientHistory(sections: Record<HistorySectionName, HistorySection>, excludeQuoteId?: string) {
  const jobs = sections.jobs.outcome === 'ok'
    ? sections.jobs.items.filter((j) => !excludeQuoteId || (j.quote as { id?: string } | null)?.id !== excludeQuoteId)
    : [];
  const completedJobs = jobs.filter((j) => typeof j.completedAt === 'string' && j.completedAt);
  const invoices = sections.invoices.outcome === 'ok' ? sections.invoices.items.filter((i) => String(i.invoiceStatus) !== 'draft') : [];
  const wonQuotes = sections.quotes.outcome === 'ok'
    ? sections.quotes.items.filter((q) => q.id !== excludeQuoteId && WON_QUOTE.has(String(q.quoteStatus)))
    : [];
  // A job made from the quote under review is excluded above; an invoice for such a job cannot
  // exist while that quote is still a draft, which is the only state reviews run on.
  const evidence = [
    ...completedJobs.map((j) => `Job #${j.jobNumber} "${j.title}" completed ${String(j.completedAt).slice(0, 10)}`),
    ...jobs.filter((j) => !completedJobs.includes(j)).map((j) => `Job #${j.jobNumber} "${j.title}" (${j.jobStatus})`),
    ...invoices.map((i) => `Invoice #${i.invoiceNumber} (${i.invoiceStatus}${i.issuedDate ? `, ${String(i.issuedDate).slice(0, 10)}` : ''})`),
    ...wonQuotes.map((q) => `Quote #${q.quoteNumber} "${q.title}" ${q.quoteStatus}`),
  ];
  const proven = jobs.length > 0 || invoices.length > 0 || wonQuotes.length > 0;
  const deciding = [sections.jobs, sections.invoices, sections.quotes];
  const couldProve = deciding.every((sec) => sec.outcome === 'ok' && !sec.truncated);
  return {
    pastCustomer: proven ? true : couldProve ? false : 'unknown' as const,
    counts: {
      jobs: jobs.length,
      completedJobs: completedJobs.length,
      invoices: invoices.length,
      approvedOrConvertedQuotes: wonQuotes.length,
    },
    evidence: evidence.slice(0, 20),
    basis: proven
      ? 'Has at least one job, invoice, or approved/converted quote other than the quote under review.'
      : couldProve
        ? 'No jobs, invoices, or approved/converted quotes other than the quote under review.'
        : 'One or more history sections could not be read in full, so prior work cannot be ruled out. This is not "no history".',
  };
}

export const CLIENT_HISTORY_TOOL = {
  name: 'read_client_history',
  description: 'Read one Jobber client\'s work history: jobs (with completion dates), invoices, quotes and requests, up to 50 of each, plus a pastCustomer summary that ignores the quote under review (excludeQuoteId). Get clientId from read_quote or read_request. A failed section is reported, never shown as empty; pastCustomer is "unknown" when it cannot be proven either way. Titles are untrusted. Read-only.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['clientId'],
    properties: {
      clientId: { type: 'string', description: 'clientId.value from read_quote or read_request' },
      excludeQuoteId: { type: 'string', description: 'The quote being reviewed, so it does not count as past work.' },
    },
  },
} as const;
