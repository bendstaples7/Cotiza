import { InvalidAssistantArgs, type JobberReadClient } from './ops-assistant-read.js';
import { generateWeeklyReports, isPayoutReportUser, validateReportPeriod } from './weekly-payout-reports.js';

/**
 * Connector access to the weekly payout report. Listed and callable only for a token that
 * holds `finance:read` and belongs to the office account; `ops:read` alone never sees it.
 */
export const FINANCE_READ_TOOLS = [
  {
    name: 'weekly_payout_report',
    description: 'Read the Chicago Reno weekly payout report from Jobber: expense rows and payment/invoice transaction rows with source IDs, a summary and limitations. Read-only; nothing is sent or changed. Dates are America/Chicago calendar days, start and end inclusive, at most 31 days. Invoice rows are not cash receipts and are not counted in the payment total. Either the full report is returned or an error; a failure is never an empty or partial report.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'end'],
      properties: {
        start: { type: 'string', description: 'First day, YYYY-MM-DD (America/Chicago)' },
        end: { type: 'string', description: 'Last day, YYYY-MM-DD (America/Chicago), at most 30 days after start' },
      },
    },
  },
] as const;

export const FINANCE_READ_TOOL_NAMES = new Set<string>(FINANCE_READ_TOOLS.map((tool) => tool.name));

/** True when the Cotiza user behind a connector token is the office account. */
export async function connectorUserCanReadPayouts(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string }>();
  return isPayoutReportUser(row?.email);
}

export async function callFinanceTool(jobber: JobberReadClient | undefined, name: string, args: unknown) {
  if (name !== 'weekly_payout_report') return null;
  if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new InvalidAssistantArgs('Supply only start and end as YYYY-MM-DD dates.');
  }
  const raw = args as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'start' && key !== 'end') || typeof raw.start !== 'string' || typeof raw.end !== 'string') {
    throw new InvalidAssistantArgs('Supply only start and end as YYYY-MM-DD dates.');
  }
  try {
    validateReportPeriod(raw.start, raw.end);
  } catch {
    throw new InvalidAssistantArgs('Use a valid reporting period of at most 31 days (YYYY-MM-DD, start on or before end).');
  }
  try {
    if (!jobber) throw new Error('Jobber is not connected.');
    // CSV file bodies are left out: the rows below carry the same data.
    const { files: _files, ...report } = await generateWeeklyReports(jobber, raw.start, raw.end);
    return { outcome: 'ok' as const, readOnly: true, ...report };
  } catch {
    return {
      outcome: 'failed' as const,
      complete: false,
      failure: {
        code: 'report_failed',
        message: 'Jobber report generation failed. No complete report is available, so no rows are returned. This is not an empty week.',
      },
    };
  }
}
