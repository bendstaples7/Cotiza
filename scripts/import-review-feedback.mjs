/**
 * One-time import of the quote-review ledger from the Staple Stack skill into Cotiza D1.
 *
 * Reads feedback.json (`feedback_entries`, `quote_reviews`, plus the older top-level
 * `calibration` (quote 669) and `quote_697` records) and writes a SQL file of
 * INSERT OR IGNORE statements. It does not touch D1 itself; you run the file with wrangler.
 * Re-running is safe: ids are fixed, so rows already imported are skipped.
 *
 * Customer contact details are not imported: keys such as client, email, phone and
 * address are dropped, and email addresses / phone numbers inside text are replaced.
 *
 *   node scripts/import-review-feedback.mjs ["C:\Users\Ben\Staple Stack\skills\chicago-reno-review-quotes\feedback.json"] [--out review-feedback-import.sql]
 *   cd worker && npx wrangler d1 execute DB --remote --file=../review-feedback-import.sql
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LEDGER_PATH = 'C:\\Users\\Ben\\Staple Stack\\skills\\chicago-reno-review-quotes\\feedback.json';

/** Matches CONTACT_KEY_RE in worker/src/services/review-feedback.ts. */
const CONTACT_KEY_RE = /^(client|client_name|customer|customer_name|contact|contact_name|email|emails|phone|phones|mobile|address|street|property_address|service_address)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[-. ]?)?\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g;
const COMPANY_EMAIL_RE = /@chicago-reno\.com$/i;

export const STATUSES = ['confirmed', 'conditional', 'accepted/closed', 'superseded', 'proposed'];

/** Maps the ledger's free-text status onto the stored set; the original wording becomes status_detail. */
export function mapStatus(raw) {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();
  let status = 'proposed';
  if (lower.startsWith('accepted/closed')) status = 'accepted/closed';
  else if (lower.startsWith('superseded')) status = 'superseded';
  else if (lower.startsWith('conditional')) status = 'conditional';
  else if (lower.startsWith('confirmed')) status = 'confirmed';
  return { status, statusDetail: text && text !== status ? text : null };
}

function scrubText(value, names) {
  let text = value
    .replace(EMAIL_RE, (email) => (COMPANY_EMAIL_RE.test(email) ? email : '[email removed]'))
    .replace(PHONE_RE, '[phone removed]');
  for (const name of names) text = text.split(name).join('the customer');
  return text;
}

/** Customer full names, taken from the `client` fields that are being dropped. */
function customerNames(ledger) {
  const names = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (CONTACT_KEY_RE.test(key) && typeof child === 'string' && /\s/.test(child.trim())) names.add(child.trim());
        walk(child);
      }
    }
  };
  walk(ledger);
  return [...names];
}

/** Deep copy without contact-detail keys; text has emails, phones and full customer names removed. */
export function scrubContact(value, names = []) {
  if (Array.isArray(value)) return value.map((item) => scrubContact(item, names));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (CONTACT_KEY_RE.test(key)) continue;
      out[key.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64)] = scrubContact(child, names);
    }
    return out;
  }
  if (typeof value === 'string') return scrubText(value, names);
  return value;
}

function quoteNumberOf(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/^#/, '');
  return /^\d{1,10}$/.test(text) ? text : null;
}

/** Converts the ledger to rows for quote_review_feedback and quote_review_records. */
export function ledgerToRows(ledger) {
  const names = customerNames(ledger);
  const importSource = `Staple Stack feedback.json (updated ${ledger.updated_on || 'unknown'})`;
  const importedAt = ledger.updated_on || new Date().toISOString().slice(0, 10);

  const entries = (ledger.feedback_entries || []).map((entry, index) => {
    const { status, statusDetail } = mapStatus(entry.status);
    return {
      seq: index + 1,
      id: String(entry.id),
      created_at: entry.date || importedAt,
      author: scrubText(String(entry.author || 'Ben'), names),
      source: scrubText(String(entry.source || importSource), names),
      quote_number: quoteNumberOf(entry.quote),
      status,
      status_detail: statusDetail,
      scope: scrubText(String(entry.scope || ''), names),
      excerpt: scrubText(String(entry.excerpt || ''), names),
      rule: scrubText(String(entry.rule || ''), names),
      supersedes: entry.supersedes ? String(entry.supersedes) : null,
    };
  });

  const recordSources = [];
  if (ledger.calibration && typeof ledger.calibration === 'object') {
    recordSources.push([quoteNumberOf(ledger.calibration.quote) || '669', ledger.calibration]);
  }
  if (ledger.quote_697 && typeof ledger.quote_697 === 'object') recordSources.push(['697', ledger.quote_697]);
  for (const [quote, record] of Object.entries(ledger.quote_reviews || {})) recordSources.push([quoteNumberOf(quote), record]);

  const records = recordSources
    .filter(([quote, record]) => quote && record && typeof record === 'object')
    .map(([quote, record]) => ({
      id: `QR-${quote}-1`,
      created_at: record.observed_on || importedAt,
      author: 'feedback.json import',
      source: importSource,
      quote_number: quote,
      record: JSON.stringify(scrubContact(record, names)),
    }));

  return { entries, records };
}

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** INSERT OR IGNORE statements. Entries keep their ledger order so cursors and F### ids line up. */
export function rowsToSql({ entries, records }) {
  const lines = ['-- Generated by scripts/import-review-feedback.mjs. Safe to re-run.'];
  for (const e of entries) {
    lines.push(
      `INSERT OR IGNORE INTO quote_review_feedback (seq, id, created_at, author, source, quote_number, status, status_detail, scope, excerpt, rule, supersedes, written_via) VALUES (${[
        e.seq, e.id, e.created_at, e.author, e.source, e.quote_number, e.status, e.status_detail, e.scope, e.excerpt, e.rule, e.supersedes,
      ].map(sql).join(', ')}, 'import');`,
    );
  }
  for (const r of records) {
    lines.push(
      `INSERT OR IGNORE INTO quote_review_records (id, created_at, author, source, quote_number, record, written_via) VALUES (${[
        r.id, r.created_at, r.author, r.source, r.quote_number, r.record,
      ].map(sql).join(', ')}, 'import');`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const args = argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = resolve(outIndex >= 0 ? args[outIndex + 1] : 'review-feedback-import.sql');
  const input = args.find((arg, i) => !arg.startsWith('--') && i !== outIndex + 1) || DEFAULT_LEDGER_PATH;
  const ledger = JSON.parse(readFileSync(input, 'utf8'));
  const rows = ledgerToRows(ledger);
  writeFileSync(out, rowsToSql(rows), 'utf8');
  console.log(`Wrote ${rows.entries.length} feedback entries and ${rows.records.length} quote records to ${out}`);
  console.log('Apply it from the worker folder (after the 0070 migration):');
  console.log(`  npx wrangler d1 execute DB --remote --file="${out}"`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
