/**
 * Smoke-test draft email-context endpoint locally.
 * Usage: node scripts/test-email-context.mjs [draftId]
 */
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const draftId = process.argv[2] || 'cec1f5ce-d123-4069-a92e-6281f6b9b0ab';

const tokenJson = execSync(
  'npx wrangler d1 execute DB --local --json --command "SELECT token FROM sessions ORDER BY created_at DESC LIMIT 1"',
  { encoding: 'utf8', cwd: workerDir },
);
const token = JSON.parse(tokenJson)[0]?.results?.[0]?.token;
if (!token) {
  console.error('No session token in local D1');
  process.exit(1);
}

const res = await fetch(`http://localhost:8787/api/quotes/drafts/${draftId}/email-context`, {
  headers: { Authorization: `Bearer ${token}` },
});
const body = await res.json();
console.log(JSON.stringify({
  status: res.status,
  ...body,
  messageCount: body.messages?.length ?? 0,
}, null, 2));
