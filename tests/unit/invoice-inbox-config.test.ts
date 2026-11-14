import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('invoice-inbox config', () => {
  it('keeps the invoice-inbox switch off by default', () => {
    const wrangler = readFileSync(resolve(import.meta.dirname, '../../worker/wrangler.toml'), 'utf8');
    const vars = wrangler.slice(wrangler.indexOf('[vars]'), wrangler.indexOf('[triggers]'));
    expect(vars).toContain('INVOICE_INBOX_GO_LIVE = "false"');
  });
});
