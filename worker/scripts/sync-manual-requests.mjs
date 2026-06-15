/**
 * Pull manual_requests AND jobber_webhook_requests from production D1 to local D1.
 *
 * Called to populate local dev queue with real production data.
 * Requires wrangler to be authenticated (`wrangler login`).
 *
 * Production is the single source of truth for requests and webhook data.
 * This script pulls those records to local so local dev has
 * realistic data.
 *
 * IMPORTANT: This script never pushes local data to production.
 *
 * Gracefully skips if:
 * - Not authenticated with Cloudflare
 * - No network access
 * - No records in production D1
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 100 * 1024 * 1024 });
}

function queryRecords(flag, table, columns, orderClause = '') {
  try {
    const output = run(
      `npx wrangler d1 execute DB ${flag} --json --command "SELECT ${columns} FROM ${table} ${orderClause}"`
    );
    const parsed = JSON.parse(output);
    return parsed[0]?.results || [];
  } catch {
    return null;
  }
}

/**
 * Escape a SQL string value for safe insertion.
 * Doubles single quotes (standard SQL escaping).
 */
function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
}

function clearAndInsertLocal(table, columns, records, idColumn) {
  if (records.length === 0) return 0;

  // Clear local table
  try { run(`npx wrangler d1 execute DB --local --command "DELETE FROM ${table}"`); } catch { /* ignore */ }

  const colList = columns.join(', ');
  let inserted = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const valueRows = batch.map(r => {
      const vals = columns.map(c => esc(r[c]));
      return `(${vals.join(', ')})`;
    });

    const sql = `INSERT INTO ${table} (${colList}) VALUES\n${valueRows.join(',\n')};`;
    const tmpFile = join(tmpdir(), `sync-${table}-${Date.now()}-${i}.sql`);
    try {
      writeFileSync(tmpFile, sql, 'utf8');
      run(`npx wrangler d1 execute DB --local --file "${tmpFile}"`);
      inserted += batch.length;
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  return inserted;
}

// ── Synced tables ──────────────────────────────────────────────

const SYNC_TABLES = [
  {
    table: 'manual_requests',
    columns: ['id', 'user_id', 'customer_name', 'customer_phone', 'customer_email', 'customer_address', 'service_description', 'media_item_ids_json', 'created_at'],
    orderClause: 'ORDER BY created_at ASC',
  },
  {
    table: 'jobber_webhook_requests',
    columns: ['id', 'jobber_request_id', 'topic', 'account_id', 'title', 'client_name', 'description', 'request_body', 'image_urls', 'raw_payload', 'received_at', 'processed_at'],
    orderClause: 'ORDER BY received_at ASC',
  },
];

// ── Main ───────────────────────────────────────────────────────

let anyFailed = false;

for (const { table, columns, orderClause } of SYNC_TABLES) {
  try {
    console.log(`[sync-manual-requests] Pulling ${table} from production D1...`);

    const remote = queryRecords('--remote', table, columns.join(', '), orderClause);

    if (!remote) {
      console.log(`[sync-manual-requests] Could not reach production D1 for ${table}. Skipping.`);
      console.log('[sync-manual-requests]   → Run `wrangler login` or set CLOUDFLARE_API_TOKEN env var to access production D1.');
      anyFailed = true;
      continue;
    }

    if (remote.length === 0) {
      console.log(`[sync-manual-requests] No ${table} in production D1. Skipping.`);
      continue;
    }

    const count = clearAndInsertLocal(table, columns, remote);
    console.log(`[sync-manual-requests] Pulled ${count} ${table} from production → local.`);
  } catch (err) {
    console.log(`[sync-manual-requests] Could not sync ${table}: ${err.message}. Skipping.`);
    anyFailed = true;
  }
}

if (anyFailed) {
  process.exit(0);
}
