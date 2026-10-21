/** Reconcile manually applied pieces of 0069 without editing its immutable SQL. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migration = '0069_deposit_payments.sql';
const statements = readFileSync(resolve(workerDir, 'src/migrations', migration), 'utf8')
  .replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
const draftColumns = [
  ['deposit_total_cents', 'INTEGER', 0, null],
  ['deposit_paid_cents', 'INTEGER', 1, '0'],
  ['deposit_status', 'TEXT', 0, "'not_applicable'"],
];
const paymentColumns = [
  ['id', 'TEXT', 0, null], ['quote_draft_id', 'TEXT', 1, null],
  ['milestone_index', 'INTEGER', 1, null], ['percentage', 'INTEGER', 1, null],
  ['amount_cents', 'INTEGER', 1, null], ['description', 'TEXT', 1, "''"],
  ['status', 'TEXT', 1, "'pending'"], ['paid_at', 'TEXT', 0, null],
  ['payment_method', 'TEXT', 0, null], ['paid_amount_cents', 'INTEGER', 0, null],
  ['notes', 'TEXT', 0, null], ['created_at', 'TEXT', 1, "datetime('now')"],
  ['updated_at', 'TEXT', 1, "datetime('now')"],
];
const normalizedDefault = v => v == null ? null : String(v).replace(/^\((.*)\)$/, '$1');
function verifyColumns(actual, expected, table) {
  for (const [name, type, notnull, defaultValue] of expected) {
    const col = actual.find(c => c.name === name);
    if (!col || col.type.toUpperCase() !== type || Number(col.notnull) !== notnull
      || normalizedDefault(col.dflt_value) !== defaultValue) {
      throw new Error(`Migration reconciliation stopped: incompatible ${table}.${name}`);
    }
  }
}

export async function reconcileDepositMigration(query) {
  // A fresh database has no migration tracker yet; normal migrations handle it.
  if (!(await query("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'")).length) return 'not-needed';
  if ((await query(`SELECT name FROM d1_migrations WHERE name='${migration}'`)).length) return 'already-recorded';
  let draft = await query('PRAGMA table_info(quote_drafts)');
  if (!draftColumns.some(([name]) => draft.some(c => c.name === name))) return 'not-needed';
  // Validate existing definitions before changing anything. Never suppress SQL failures.
  verifyColumns(draft, draftColumns.filter(([name]) => draft.some(c => c.name === name)), 'quote_drafts');
  for (const sql of statements) {
    const added = sql.match(/^ALTER TABLE quote_drafts ADD COLUMN (\w+) /i)?.[1];
    if (added && draft.some(c => c.name === added)) continue;
    if (!added && !/^CREATE (?:TABLE|INDEX) IF NOT EXISTS /i.test(sql)) throw new Error('Unexpected 0069 statement');
    await query(sql);
  }
  draft = await query('PRAGMA table_info(quote_drafts)');
  const payments = await query('PRAGMA table_info(deposit_payments)');
  verifyColumns(draft, draftColumns, 'quote_drafts');
  verifyColumns(payments, paymentColumns, 'deposit_payments');
  if (Number(payments.find(c => c.name === 'id')?.pk) !== 1) throw new Error('Deposit payment primary key mismatch');
  const fk = await query('PRAGMA foreign_key_list(deposit_payments)');
  if (!fk.some(f => f.table === 'quote_drafts' && f.from === 'quote_draft_id' && f.to === 'id')) throw new Error('Deposit payment foreign key mismatch');
  for (const [index, column] of [['idx_deposit_payments_draft_id', 'quote_draft_id'], ['idx_deposit_payments_status', 'status']]) {
    const cols = await query(`PRAGMA index_info(${index})`);
    if (cols.length !== 1 || cols[0].name !== column) throw new Error('Deposit payment index mismatch');
  }
  const definitions = await query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('quote_drafts','deposit_payments')");
  const compact = name => (definitions.find(t => t.name === name)?.sql || '').toLowerCase().replace(/\s+/g, '');
  for (const check of ["check(percentage>0andpercentage<=100)", 'check(amount_cents>=0)', "check(statusin('pending','paid','cancelled'))"]) {
    if (!compact('deposit_payments').includes(check)) throw new Error('Deposit payment constraint mismatch');
  }
  if (!compact('quote_drafts').includes("check(deposit_statusin('not_applicable','pending','partial','paid','cancelled'))")) throw new Error('Deposit status constraint mismatch');
  // Record only after every table, column, index and constraint has been verified.
  await query(`INSERT INTO d1_migrations (name) VALUES ('${migration}')`);
  return 'reconciled';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv.includes('--remote') ? '--remote' : '--local';
  const query = async sql => {
    const output = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, '--json', '--command', sql],
      { cwd: workerDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(output);
    if (!Array.isArray(result) || result.some(r => r.success === false)) throw new Error('D1 schema query failed');
    return result.flatMap(r => r.results || []);
  };
  try { console.log(`[migration-0069] ${await reconcileDepositMigration(query)}`); }
  catch (error) { console.error(`[migration-0069] ${error.message}`); process.exitCode = 1; }
}
