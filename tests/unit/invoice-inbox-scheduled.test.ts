import { describe, it, expect, vi, afterEach } from 'vitest';

const { scan, open, keepAlive, KEEPALIVE_CRON } = vi.hoisted(() => ({
  scan: vi.fn(async () => {}),
  open: vi.fn(async () => {
    throw new Error('jobber down');
  }),
  keepAlive: vi.fn(async () => {}),
  KEEPALIVE_CRON: '*/30 * * * *',
}));

vi.mock('../../worker/src/services/invoice-inbox-scan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worker/src/services/invoice-inbox-scan.js')>()),
  runInvoiceInboxScan: scan,
}));
vi.mock('../../worker/src/services/jobber-integration.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worker/src/services/jobber-integration.js')>()),
  openJobberIntegration: open,
}));
vi.mock('../../worker/src/scheduled/jobber-session-keepalive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worker/src/scheduled/jobber-session-keepalive.js')>()),
  handleJobberSessionKeepAlive: keepAlive,
  JOBBER_SESSION_KEEPALIVE_CRON: KEEPALIVE_CRON,
}));

import worker from '../../worker/src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('invoice inbox scheduled pass', () => {
  it('still runs the dry-run scan when the go-live Jobber setup throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {};
    const env = {
      DB: db,
      R2_BUCKET: { list: vi.fn(async () => ({ objects: [], truncated: false })) },
      GMAIL_CLIENT_ID: 'id',
      GMAIL_CLIENT_SECRET: 'secret',
      GMAIL_REFRESH_TOKEN: 'refresh',
      INVOICE_INBOX_GO_LIVE: 'true',
    } as never;
    const waitUntil = vi.fn();
    await worker.scheduled({ cron: KEEPALIVE_CRON } as never, env, { waitUntil } as never);
    await Promise.all(waitUntil.mock.calls.map((call) => call[0]));
    expect(open).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(expect.anything(), db);
  });
});
