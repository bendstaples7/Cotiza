/**
 * Pull Gmail OAuth secrets from the deployed worker into local .dev.vars.
 *
 * Cloudflare does not expose secret values via wrangler/API, so this calls a
 * protected admin route on production that returns Gmail creds when authorized
 * with the same CLOUDFLARE_API_TOKEN already in .dev.vars.
 *
 * Usage (from worker/):
 *   node scripts/pull-gmail-secrets.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(__dirname, '..');
const DEV_VARS_PATH = join(WORKER_DIR, '.dev.vars');
const PROD_WORKER_URL = 'https://social-media-cross-poster.chicago-reno.workers.dev';

const GMAIL_KEYS = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
const OPTIONAL = process.argv.includes('--optional');

function parseDevVars(content) {
  const map = new Map();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function quoteDevVarValue(value) {
  // Google refresh tokens often start with `1//` — quote so dotenv parsers don't truncate.
  if (/[\s#"'\\]/.test(value) || value.includes('//')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function upsertDevVars(content, updates) {
  let lines = content.split('\n');
  const existingKeys = new Set();

  lines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (updates[key] !== undefined) {
      existingKeys.add(key);
      return `${key}=${quoteDevVarValue(updates[key])}`;
    }
    return line;
  });

  for (const key of GMAIL_KEYS) {
    if (updates[key] !== undefined && !existingKeys.has(key)) {
      lines.push(`${key}=${quoteDevVarValue(updates[key])}`);
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

async function main() {
  let content;
  try {
    content = readFileSync(DEV_VARS_PATH, 'utf8');
  } catch {
    console.error('[pull-gmail-secrets] ERROR: .dev.vars not found. Copy .dev.vars.example first.');
    process.exit(1);
  }

  const vars = parseDevVars(content);
  const hasGmail = GMAIL_KEYS.every((key) => vars.get(key)?.trim());
  if (hasGmail && OPTIONAL) {
    console.log('[pull-gmail-secrets] Gmail secrets already present in .dev.vars — skipping.');
    return;
  }

  const apiToken = vars.get('CLOUDFLARE_API_TOKEN');
  if (!apiToken) {
    console.error('[pull-gmail-secrets] ERROR: CLOUDFLARE_API_TOKEN missing from .dev.vars');
    process.exit(OPTIONAL ? 0 : 1);
  }

  console.log('[pull-gmail-secrets] Fetching Gmail secrets from production worker...');

  const res = await fetch(`${PROD_WORKER_URL}/api/admin/dev-secrets/gmail`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[pull-gmail-secrets] ERROR: Production returned ${res.status}: ${body}`);
    if (res.status === 404) {
      console.error('[pull-gmail-secrets] Deploy the worker first so the admin route exists, then re-run.');
    }
    process.exit(OPTIONAL ? 0 : 1);
  }

  const data = await res.json();
  const updates = {};
  for (const key of GMAIL_KEYS) {
    if (!data[key]?.trim()) {
      console.error(`[pull-gmail-secrets] ERROR: Production response missing ${key}`);
      process.exit(OPTIONAL ? 0 : 1);
    }
    updates[key] = data[key].trim();
  }

  const updated = upsertDevVars(content, updates);
  writeFileSync(DEV_VARS_PATH, updated, 'utf8');
  console.log('[pull-gmail-secrets] ✅ Wrote GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN to .dev.vars');
}

main().catch((err) => {
  console.error('[pull-gmail-secrets] Failed:', err.message || err);
  process.exit(OPTIONAL ? 0 : 1);
});
