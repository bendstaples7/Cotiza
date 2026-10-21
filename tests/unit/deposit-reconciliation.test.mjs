import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { reconcileDepositMigration } from '../../worker/scripts/reconcile-deposit-migration.mjs';

const migration = readFileSync(new URL('../../worker/src/migrations/0069_deposit_payments.sql', import.meta.url), 'utf8');
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE); CREATE TABLE quote_drafts (id TEXT PRIMARY KEY);');
  const query = async sql => db.prepare(sql).all();
  return { db, query, recorded: () => db.prepare('SELECT name FROM d1_migrations').all().length };
}
test('leaves a fresh schema for the normal migration runner', async () => {
  const { db, query, recorded } = database();
  assert.equal(await reconcileDepositMigration(query), 'not-needed');
  assert.equal(recorded(), 0);
  db.exec(migration);
  assert.equal(db.prepare('PRAGMA table_info(deposit_payments)').all().length, 13);
  db.close();
});
test('reconciles a fully applied but unrecorded migration and preserves records', async () => {
  const { db, query, recorded } = database();
  db.exec(migration);
  db.exec("INSERT INTO quote_drafts (id, deposit_total_cents) VALUES ('existing', 5000)");
  assert.equal(await reconcileDepositMigration(query), 'reconciled');
  assert.equal(recorded(), 1);
  assert.equal(db.prepare('SELECT deposit_total_cents FROM quote_drafts').get().deposit_total_cents, 5000);
  assert.equal(await reconcileDepositMigration(query), 'already-recorded');
  db.close();
});
test('repairs the exact duplicate-column failure, including remaining columns and tables', async () => {
  const { db, query, recorded } = database();
  db.exec('ALTER TABLE quote_drafts ADD COLUMN deposit_total_cents INTEGER');
  assert.equal(await reconcileDepositMigration(query), 'reconciled');
  assert.equal(recorded(), 1);
  assert.equal(db.prepare('PRAGMA table_info(quote_drafts)').all().length, 4);
  assert.throws(() => db.exec("INSERT INTO deposit_payments(id,quote_draft_id,milestone_index,percentage,amount_cents) VALUES ('bad','q',0,101,0)"), /CHECK/);
  db.close();
});
test('rejects incompatible existing columns before recording or adding anything', async () => {
  const { db, query, recorded } = database();
  db.exec('ALTER TABLE quote_drafts ADD COLUMN deposit_total_cents TEXT');
  await assert.rejects(reconcileDepositMigration(query), /incompatible quote_drafts.deposit_total_cents/);
  assert.equal(recorded(), 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='deposit_payments'").all().length, 0);
  db.close();
});
test('does not record completion after a database failure', async () => {
  const { db, query, recorded } = database();
  db.exec('ALTER TABLE quote_drafts ADD COLUMN deposit_total_cents INTEGER');
  await assert.rejects(reconcileDepositMigration(sql => {
    if (sql.startsWith('CREATE INDEX')) throw new Error('database unavailable');
    return query(sql);
  }), /database unavailable/);
  assert.equal(recorded(), 0);
  assert.equal(await reconcileDepositMigration(query), 'reconciled');
  db.close();
});
test('rejects missing constraints even when all column names exist', async () => {
  const { db, query, recorded } = database();
  db.exec(migration.replace("CHECK(status IN ('pending', 'paid', 'cancelled'))", ''));
  await assert.rejects(reconcileDepositMigration(query), /constraint mismatch/);
  assert.equal(recorded(), 0);
  db.close();
});
