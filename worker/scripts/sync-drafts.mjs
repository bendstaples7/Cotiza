#!/usr/bin/env node
/**
 * Pull quote_drafts from production D1 to local D1.
 * Synced automatically by `npm run dev`.
 *
 * Requires CLOUDFLARE_API_TOKEN env var to be set before running.
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const COLS = [
  'id', 'user_id', 'customer_request_text', 'selected_template_id',
  'selected_template_name', 'catalog_source', 'status', 'created_at',
  'updated_at', 'jobber_request_id', 'draft_number', 'pending_enrichments',
  'jobber_quote_id', 'jobber_quote_number', 'customer_note',
  'jobber_quote_web_uri', 'manual_request_id', 'sqft_resolution_json',
  'deposit_schedule', 'space_context_json', 'generation_trace_json',
  'quote_sent_at', 'first_draft_created_at', 'request_to_quote_seconds',
  'last_quote_sent_at', 'backfilled_at', 'metric_status'
];

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 100 * 1024 * 1024 });
}

function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

if (!TOKEN) {
  console.log('[sync-drafts] CLOUDFLARE_API_TOKEN not set. Skipping.');
  process.exit(0);
}

console.log('[sync-drafts] Pulling quote_drafts from production D1...');

let remote;
try {
  const out = run(`npx wrangler d1 execute DB --remote --command "SELECT * FROM quote_drafts ORDER BY created_at ASC"`);
  const lines = out.split('\n');
  const jsonStart = lines.findIndex(l => l.trim().startsWith('['));
  if (jsonStart < 0) throw new Error('No JSON array in output');
  remote = JSON.parse(lines.slice(jsonStart).join('\n'))[0]?.results || [];
} catch (e) {
  console.log(`[sync-drafts] Could not reach production D1: ${e.message.substring(0,100)}. Skipping.`);
  process.exit(0);
}

if (remote.length === 0) {
  console.log('[sync-drafts] No drafts in production. Skipping.');
  process.exit(0);
}

console.log(`[sync-drafts] Found ${remote.length} drafts.`);

// Ensure referenced users exist
const userIds = [...new Set(remote.map(d => d.user_id).filter(Boolean))];
for (const uid of userIds) {
  try {
    const e = uid.replace(/'/g, "''");
    run(`npx wrangler d1 execute DB --local --command "INSERT OR IGNORE INTO users (id, email, name, created_at, last_active_at) VALUES ('${e}', 'synced@local.dev', 'Synced User', datetime('now'), datetime('now'))"`);
  } catch { /* best effort */ }
}

// Clear local drafts
run(`npx wrangler d1 execute DB --local --command "DELETE FROM quote_drafts"`);

// Insert in batches of 20
for (let i = 0; i < remote.length; i += 20) {
  const batch = remote.slice(i, i + 20);
  const values = batch.map(d => {
    if (d.customer_request_text == null) d.customer_request_text = '';
    return '(' + COLS.map(c => esc(d[c])).join(',') + ')';
  }).join(',\n');
  const sql = `INSERT INTO quote_drafts (${COLS.join(',')}) VALUES\n${values};`;
  const tmpFile = `/tmp/sync-drafts-${Date.now()}-${i}.sql`;
  try {
    writeFileSync(tmpFile, sql, 'utf8');
    run(`npx wrangler d1 execute DB --local --file "${tmpFile}"`);
  } finally {
    try { require('fs').unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// Remap user_id to local user (ben@chicago-reno.com) for local dev
const LOCAL_USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
run(`npx wrangler d1 execute DB --local --command "UPDATE quote_drafts SET user_id = '${LOCAL_USER_ID}' WHERE user_id != '${LOCAL_USER_ID}'"`);

console.log(`[sync-drafts] Done. ${remote.length} quote_drafts synced.`);