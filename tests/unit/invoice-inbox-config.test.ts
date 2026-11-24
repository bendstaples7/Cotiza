import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INVOICE_INBOX_CRON } from '../../worker/src/services/invoice-inbox-scan.js';

describe('invoice-inbox config', () => {
  it('has the invoice inbox live and scheduled every 4 hours (Ben 2026-11-24)', () => {
    const wrangler = readFileSync(resolve(import.meta.dirname, '../../worker/wrangler.toml'), 'utf8');
    const vars = wrangler.slice(wrangler.indexOf('[vars]'), wrangler.indexOf('[triggers]'));
    expect(vars).toContain('INVOICE_INBOX_GO_LIVE = "true"');
    expect(wrangler.slice(wrangler.indexOf('[triggers]'))).toContain(`"${INVOICE_INBOX_CRON}"`);
  });
});
