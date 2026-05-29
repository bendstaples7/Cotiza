#!/usr/bin/env node
/**
 * Sync quote_drafts from production D1 into local D1.
 *
 * The deathclock feature needs real request/quote data to test with.
 * Production manual_requests is empty (the feature hasn't launched yet),
 * so this syncs quote_drafts which have the request text, status, and timing data.
 *
 * Usage:
 *   node scripts/sync-requests.mjs              # Pull: production → local (default: 50)
 *   node scripts/sync-requests.mjs --limit 100  # Pull: production → local (100 most recent)
 *   node scripts/sync-requests.mjs --limit 0    # Pull: ALL production drafts (no limit)
 *   node scripts/sync-requests.mjs --list       # List production drafts only (dry-run)
 *
 * Gracefully skips if:
 * - Not authenticated with Cloudflare
 * - No network access
 * - No drafts in production
 *
 * NOTE: This does NOT support --push. Drafts are test data that should never
 * be pushed back to production.
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const listOnly = process.argv.includes('--list');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 50;

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function runWithFile(flag, sql) {
  const tmpFile = join(tmpdir(), `sync-requests-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  try {
    writeFileSync(tmpFile, sql, 'utf8');
    return run(`npx wrangler d1 execute DB ${flag} --yes --file "${tmpFile}"`);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function execFile(flag, sql) {
  runWithFile(flag, sql);
}

function query(flag, sql) {
  try {
    const output = run(`npx wrangler d1 execute DB ${flag} --json --command "${sql.replace(/"/g, '\\"')}"`);
    const parsed = JSON.parse(output);
    return parsed[0]?.results || [];
  } catch (err) {
    console.debug(`[sync-requests] query failed: ${err.message}`);
    return null;
  }
}

function sqlVal(s) {
  if (s === null || s === undefined) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Columns that exist in BOTH production and local quote_drafts.
// Deathclock columns (quote_sent_at, first_draft_created_at, etc.) are local-only
// since the feature hasn't been deployed to production — they stay NULL.
const DRAFT_COLUMNS = [
  'id',
  'user_id',
  'customer_request_text',
  'selected_template_id',
  'selected_template_name',
  'catalog_source',
  'status',
  'created_at',
  'updated_at',
  'jobber_request_id',
  'draft_number',
  'pending_enrichments',
  'jobber_quote_id',
  'jobber_quote_number',
  'customer_note',
  'jobber_quote_web_uri',
  'manual_request_id',
  'sqft_resolution_json',
  'deposit_schedule',
  'space_context_json',
  'generation_trace_json',
];

const DRAFT_COLUMNS_SQL = DRAFT_COLUMNS.join(', ');

function buildUpsertSql(drafts) {
  const sqlLines = [];

  for (const d of drafts) {
    const vals = DRAFT_COLUMNS.map(col => sqlVal(d[col])).join(', ');
    sqlLines.push(
      `INSERT OR IGNORE INTO quote_drafts (${DRAFT_COLUMNS_SQL}) VALUES (${vals});`
    );
    sqlLines.push(
      `UPDATE quote_drafts SET ` +
        DRAFT_COLUMNS.filter(c => c !== 'id' && c !== 'created_at').map(c =>
          `${c} = ${sqlVal(d[c])}`
        ).join(', ') +
      ` WHERE id = ${sqlVal(d.id)};`
    );
  }

  return sqlLines.join('\n');
}

try {
  // ── Pull: production → local ────────────────────────────

  // Build the query — limit is applied in SQL for efficiency unless --limit=0 (no limit)
  const limitClause = LIMIT === 0 ? '' : `LIMIT ${LIMIT}`;

  console.log(
    listOnly
      ? `[sync-requests] Listing up to ${LIMIT === 0 ? 'ALL' : LIMIT} production drafts...`
      : `[sync-requests] Pulling up to ${LIMIT === 0 ? 'ALL' : LIMIT} production drafts...`
  );

  const remoteDrafts = query('--remote', `SELECT ${DRAFT_COLUMNS_SQL} FROM quote_drafts ORDER BY created_at DESC ${limitClause}`);

  if (!remoteDrafts) {
    console.log('[sync-requests] Could not reach production D1. Skipping.');
    process.exit(0);
  }

  console.log(`[sync-requests] Found ${remoteDrafts.length} drafts in production.`);

  // Show status breakdown
  const byStatus = {};
  for (const d of remoteDrafts) {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status}: ${count}`);
  }

  // Show a few preview lines
  const preview = remoteDrafts.slice(0, 5);
  for (const d of preview) {
    const label = d.customer_request_text?.slice(0, 60).replace(/\n/g, ' ') || '(empty)';
    const age = d.created_at ? d.created_at.slice(0, 10) : '?';
    console.log(`  [${age}] ${d.status === 'finalized' ? '✅' : '📝'} ${label}`);
  }
  if (remoteDrafts.length > 5) {
    console.log(`  ... and ${remoteDrafts.length - 5} more`);
  }

  if (listOnly) {
    process.exit(0);
  }

  if (remoteDrafts.length === 0) {
    console.log('[sync-requests] No drafts in production. Skipping.');
    process.exit(0);
  }

  const sql = buildUpsertSql(remoteDrafts);
  execFile('--local', sql);
  console.log(`[sync-requests] Synced ${remoteDrafts.length} drafts from production → local.`);

} catch (err) {
  console.log(`[sync-requests] Could not sync requests: ${err.message}. Skipping.`);
  process.exit(0);
}