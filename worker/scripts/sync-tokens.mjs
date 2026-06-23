/**
 * Pull Jobber OAuth tokens from production D1 to local D1.
 *
 * Called automatically by `npm run dev` before starting wrangler dev.
 * Requires wrangler to be authenticated (`wrangler login`).
 *
 * Production is the single source of truth for Jobber tokens.
 * The deployed worker refreshes tokens automatically and persists
 * them to remote D1. This script pulls those tokens to local so
 * local dev always has fresh credentials.
 *
 * IMPORTANT: This script never pushes local tokens to production.
 * Jobber uses single-use refresh tokens — pushing a stale local
 * refresh token to production would invalidate the worker's valid one.
 *
 * Gracefully skips if:
 * - Not authenticated with Cloudflare
 * - No network access
 * - No tokens in production D1
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function queryTokens(flag) {
  try {
    const output = run(
      `npx wrangler d1 execute DB ${flag} --json --command "SELECT access_token, refresh_token, updated_at FROM jobber_tokens WHERE id = 'default'"`
    );
    const parsed = JSON.parse(output);
    const results = parsed[0]?.results || [];
    if (results.length === 0) return null;
    return results[0];
  } catch {
    return null;
  }
}

function upsertTokens(flag, accessToken, refreshToken) {
  const escapedAccess = accessToken.replace(/'/g, "''");
  const escapedRefresh = refreshToken.replace(/'/g, "''");
  const sql = `INSERT INTO jobber_tokens (id, access_token, refresh_token, updated_at) VALUES ('default', '${escapedAccess}', '${escapedRefresh}', datetime('now')) ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, updated_at = excluded.updated_at;`;
  const tmpFile = join(tmpdir(), `sync-tokens-${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, sql, 'utf8');
    run(`npx wrangler d1 execute DB ${flag} --file "${tmpFile}"`);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

try {
  console.log('[sync-tokens] Pulling Jobber tokens from production D1...');

  const remote = queryTokens('--remote');

  if (!remote) {
    console.log('[sync-tokens] No tokens in production D1. Skipping.');
    process.exit(0);
  }

  const force = process.argv.includes('--force');
  const local = queryTokens('--local');

  if (local && !force) {
    const localTime = Date.parse(String(local.updated_at).replace(' ', 'T') + 'Z') || 0;
    const remoteTime = Date.parse(String(remote.updated_at).replace(' ', 'T') + 'Z') || 0;
    if (localTime >= remoteTime) {
      console.log('[sync-tokens] Local tokens are at least as recent as production — keeping local.');
      process.exit(0);
    }
    console.log('[sync-tokens] Production tokens are newer — updating local.');
  }

  upsertTokens('--local', remote.access_token, remote.refresh_token);
  console.log('[sync-tokens] Pulled tokens from production → local.');

} catch (err) {
  console.log(`[sync-tokens] Could not reach production D1: ${err.message}. Skipping.`);
  process.exit(0);
}
