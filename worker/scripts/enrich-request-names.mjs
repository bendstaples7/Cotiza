#!/usr/bin/env node
/**
 * Enrich manual_requests with real customer names and request details from Jobber.
 *
 * 1. Reads Jobber OAuth tokens from local D1
 * 2. Refreshes expired token using the OAuth refresh flow
 * 3. Fetches request details (title, contactName, client name) from Jobber GraphQL
 * 4. Updates manual_requests with customer names
 * 5. Saves refreshed tokens back to local D1
 *
 * Requires: jobber_tokens in local D1, JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET in .dev.vars
 *
 * Usage:
 *   node scripts/enrich-request-names.mjs
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_URL = 'https://api.getjobber.com/api/graphql';
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function queryLocal(sql) {
  try {
    const output = run(`npx wrangler d1 execute DB --local --json --command "${sql.replace(/"/g, '\\"')}"`);
    const parsed = JSON.parse(output);
    return parsed[0]?.results || [];
  } catch (err) {
    return null;
  }
}

function execSQL(sql) {
  const tmpFile = join(tmpdir(), `enrich-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  try {
    writeFileSync(tmpFile, sql, 'utf8');
    run(`npx wrangler d1 execute DB --local --file "${tmpFile}"`);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function sqlVal(s) {
  if (s === null || s === undefined) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}

function loadEnvVars() {
  // Read .dev.vars from the worker directory
  const devVarsPath = join(__dirname, '..', '..', '.dev.vars');
  try {
    const content = readFileSync(devVarsPath, 'utf8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

async function refreshToken(accessToken, refreshToken) {
  const envVars = loadEnvVars();
  const clientId = envVars.JOBBER_CLIENT_ID;
  const clientSecret = envVars.JOBBER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log('[enrich-names] JOBBER_CLIENT_ID or JOBBER_CLIENT_SECRET not found in .dev.vars. Skipping refresh.');
    return accessToken;
  }

  if (!refreshToken) {
    console.log('[enrich-names] No refresh token available. Skipping refresh.');
    return accessToken;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    console.log(`[enrich-names] Token refresh failed (${response.status}): ${text.slice(0, 200)}. Proceeding with stale token.`);
    return accessToken;
  }

  const data = await response.json();
  const newAccessToken = data.access_token;
  const newRefreshToken = data.refresh_token || refreshToken;

  // Persist refreshed tokens to local D1
  execSQL(
    `INSERT INTO jobber_tokens (id, access_token, refresh_token, updated_at) ` +
    `VALUES ('default', ${sqlVal(newAccessToken)}, ${sqlVal(newRefreshToken)}, datetime('now')) ` +
    `ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, updated_at = excluded.updated_at;`
  );

  console.log('[enrich-names] Token refreshed and saved to local D1.');
  return newAccessToken;
}

async function fetchRequests(accessToken) {
  const query = `
    query FetchRequests($first: Int!, $after: String) {
      requests(first: $first, after: $after, sort: [{ key: REQUESTED_AT, direction: DESCENDING }]) {
        edges {
          node {
            id
            title
            contactName
            companyName
            client { id firstName lastName companyName }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const results = {};
  let cursor = null;
  let pages = 0;

  while (pages < 3) { // Max 3 pages = ~150 requests (plenty for 29 IDs)
    pages++;
    const variables = { first: 50 };
    if (cursor) variables.after = cursor;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-JOBBER-GRAPHQL-VERSION': '2025-04-16',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jobber API ${response.status}: ${text.slice(0, 200)}`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL error: ${result.errors[0].message}`);
    }

    const edges = result?.data?.requests?.edges || [];
    for (const { node } of edges) {
      if (!node || !node.id) continue;
      const clientName = [node.client?.firstName, node.client?.lastName].filter(Boolean).join(' ') || null;
      results[node.id] = {
        title: node.title || null,
        customerName: clientName || node.contactName || node.companyName || node.client?.companyName || null,
      };
    }

    const pageInfo = result?.data?.requests?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  console.log(`[enrich-names] Fetched ${Object.keys(results).length} request details across ${pages} page(s).`);
  return results;
}

async function main() {
  // ── 1. Get tokens from local D1 ──────────────────────────
  const tokens = queryLocal("SELECT access_token, refresh_token FROM jobber_tokens WHERE id = 'default'");
  if (!tokens || tokens.length === 0) {
    console.log('[enrich-names] No Jobber tokens in local D1. Run sync-tokens.mjs first.');
    process.exit(0);
  }

  let accessToken = tokens[0].access_token;
  const storedRefreshToken = tokens[0].refresh_token;

  if (!accessToken) {
    console.log('[enrich-names] Empty Jobber access token. Skipping.');
    process.exit(0);
  }

  // ── 2. Refresh token if expired ──────────────────────────
  console.log('[enrich-names] Checking token freshness...');
  accessToken = await refreshToken(accessToken, storedRefreshToken);

  // ── 3. Get unique jobber_request_ids from quote_drafts ────
  const drafts = queryLocal(
    'SELECT DISTINCT qd.jobber_request_id ' +
    'FROM quote_drafts qd ' +
    'WHERE qd.jobber_request_id IS NOT NULL'
  );

  if (!drafts || drafts.length === 0) {
    console.log('[enrich-names] No quote_drafts with jobber_request_id found. Run sync-requests.mjs first.');
    process.exit(0);
  }

  const targetIds = new Set(drafts.map(d => d.jobber_request_id));
  console.log(`[enrich-names] Looking up ${targetIds.size} unique Jobber request IDs.`);

  // ── 4. Fetch request details from Jobber ──────────────────
  console.log('[enrich-names] Fetching request details from Jobber...');
  const requestMap = await fetchRequests(accessToken);

  // Match fetched requests to our IDs
  const matched = {};
  for (const [id, details] of Object.entries(requestMap)) {
    if (targetIds.has(id) && details.customerName) {
      matched[id] = details;
    }
  }

  console.log(`[enrich-names] Matched ${Object.keys(matched).length}/${targetIds.size} requests with customer names.`);

  if (Object.keys(matched).length === 0) {
    console.log('[enrich-names] No names matched. Skipping update.');
    process.exit(0);
  }

  // ── 5. Update manual_requests with customer names ──────────
  const mapping = queryLocal(
    'SELECT mr.id as manual_id, qd.jobber_request_id ' +
    'FROM manual_requests mr ' +
    'JOIN quote_drafts qd ON qd.manual_request_id = mr.id ' +
    'WHERE qd.jobber_request_id IS NOT NULL'
  );

  if (!mapping || mapping.length === 0) {
    console.log('[enrich-names] No manual_requests linked to quote_drafts. Skipping update.');
    process.exit(0);
  }

  let updated = 0;
  const seen = new Set();
  for (const m of mapping) {
    if (seen.has(m.manual_id)) continue;
    seen.add(m.manual_id);

    const match = matched[m.jobber_request_id];
    if (match && match.customerName) {
      execSQL(`UPDATE manual_requests SET customer_name = ${sqlVal(match.customerName)} WHERE id = ${sqlVal(m.manual_id)};`);
      updated++;
    }
  }

  console.log(`[enrich-names] Updated ${updated} manual_requests with real customer names.`);

  // Preview
  const samples = Object.entries(matched).slice(0, 5);
  for (const [id, details] of samples) {
    console.log(`  ✅ ${details.customerName} — ${details.title || '(no title)'}`);
  }
  if (Object.keys(matched).length > 5) {
    console.log(`  ... and ${Object.keys(matched).length - 5} more`);
  }
}

main().catch(err => {
  console.log(`[enrich-names] Error: ${err.message}. Skipping.`);
  process.exit(0);
});