#!/usr/bin/env node
/**
 * Transform synced quote_drafts into manual_requests for local testing.
 *
 * The deathclock dashboard queries manual_requests, not quote_drafts directly.
 * Since production manual_requests is empty (all requests come via Jobber), we
 * create synthetic manual_requests from the synced quote_drafts data, linked
 * via manual_request_id and re-parented to the specified local user.
 *
 * Usage:
 *   node scripts/setup-local-requests.mjs <user_id>
 *
 * Example:
 *   node scripts/setup-local-requests.mjs 374307fe-a278-4411-9ea8-3967268ce3d1
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

const TARGET_USER_ID = process.argv[2];
if (!TARGET_USER_ID) {
  console.error('Usage: node scripts/setup-local-requests.mjs <user_id>');
  console.error('Example: node scripts/setup-local-requests.mjs 374307fe-a278-4411-9ea8-3967268ce3d1');
  process.exit(1);
}

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function runWithFile(sql) {
  const tmpFile = join(tmpdir(), `setup-local-req-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  try {
    writeFileSync(tmpFile, sql, 'utf8');
    return run(`npx wrangler d1 execute DB --local --yes --file "${tmpFile}"`);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function query(sql) {
  try {
    const output = run(`npx wrangler d1 execute DB --local --json --command "${sql.replace(/"/g, '\\"')}"`);
    const parsed = JSON.parse(output);
    return parsed[0]?.results || [];
  } catch (err) {
    console.debug(`[setup-local-requests] query failed: ${err.message}`);
    return null;
  }
}

function sqlVal(s) {
  if (s === null || s === undefined) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}

function uuid() {
  return crypto.randomUUID();
}

try {
  // Step 1: Verify target user exists
  const userCheck = query(`SELECT id, name FROM users WHERE id = ${sqlVal(TARGET_USER_ID)}`);
  if (!userCheck || userCheck.length === 0) {
    console.error(`[setup-local-requests] User ${TARGET_USER_ID} not found in local D1.`);
    console.error('Available users:');
    const users = query('SELECT id, name, email FROM users');
    for (const u of users) {
      console.error(`  ${u.id.slice(0, 30)}  ${u.name}  <${u.email}>`);
    }
    process.exit(1);
  }
  console.log(`[setup-local-requests] Target user: ${userCheck[0].name} (${TARGET_USER_ID.slice(0, 16)}...)`);

  // Step 2: Get quote_drafts that DON'T have a manual_request_id
  const drafts = query(`
    SELECT id, user_id, customer_request_text, jobber_request_id, status, created_at, updated_at
    FROM quote_drafts
    WHERE manual_request_id IS NULL
  `);

  if (!drafts || drafts.length === 0) {
    console.log('[setup-local-requests] No quote_drafts without manual_request_id found. Nothing to do.');
    process.exit(0);
  }

  console.log(`[setup-local-requests] Found ${drafts.length} drafts to convert.`);

  // Step 3: Build SQL to create manual_requests and update quote_drafts
  const sqlLines = [];
  let created = 0;

  for (const d of drafts) {
    const mrId = uuid();
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];

    // Build a display title from the request text instead of hardcoding "Jobber Customer"
    const raw = d.customer_request_text || '';
    const stripped = raw.replace(/^Please provide as much information as you can:\s*/i, '').trim();
    const displayName = stripped.slice(0, 60).split('\n')[0].trim() || 'Jobber Request';

    // Create manual_request
    sqlLines.push(
      `INSERT OR IGNORE INTO manual_requests (id, user_id, customer_name, service_description, created_at, status)` +
      ` VALUES (${sqlVal(mrId)}, ${sqlVal(TARGET_USER_ID)}, ${sqlVal(displayName)}, ${sqlVal(d.customer_request_text || '')}, ${sqlVal(d.created_at)}, 'pending');`
    );

    // Link the quote_draft to this manual_request and re-parent to target user
    sqlLines.push(
      `UPDATE quote_drafts SET manual_request_id = ${sqlVal(mrId)}, user_id = ${sqlVal(TARGET_USER_ID)}` +
      ` WHERE id = ${sqlVal(d.id)};`
    );

    created++;
  }

  console.log(`[setup-local-requests] Creating ${created} manual_requests and linking to drafts...`);

  const sql = sqlLines.join('\n');
  runWithFile(sql);

  console.log(`[setup-local-requests] Done. Created ${created} manual_requests for user ${userCheck[0].name}.`);

  // Step 4: Verify
  const verify = query(`
    SELECT mr.status, COUNT(*) as count
    FROM manual_requests mr
    WHERE mr.user_id = ${sqlVal(TARGET_USER_ID)}
    GROUP BY mr.status
  `);

  if (verify) {
    console.log('[setup-local-requests] Verification:');
    for (const v of verify) {
      console.log(`  ${v.status}: ${v.count}`);
    }
  }

} catch (err) {
  console.log(`[setup-local-requests] Failed: ${err.message}`);
  process.exit(0);
}