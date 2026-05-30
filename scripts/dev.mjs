#!/usr/bin/env node
/**
 * Unified local development startup script.
 * Runs the full setup sequence, then starts both worker and client dev servers.
 * 
 * Usage: node scripts/dev.mjs
 * Or:    npm run dev:all
 */
import { execSync, spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const workerDir = resolve(root, 'worker');

function step(label, cmd, cwd = workerDir) {
  console.log(`\n⏳ ${label}...`);
  try {
    execSync(cmd, { cwd, stdio: 'inherit' });
    console.log(`✅ ${label}`);
  } catch (err) {
    console.error(`❌ ${label} failed`);
    process.exit(1);
  }
}

// ── Setup steps (sequential, must all pass) ──────────────────
// NOTE: migrations, token sync, and cookie sync are handled by the worker's
// own `npm run dev` script, so they run on every worker startup automatically.

step('Building shared types', 'npm run build --workspace=shared', root);
step('Syncing rules from production', 'node scripts/sync-rules.mjs');
step('Syncing product catalog from production', 'node scripts/sync-catalog.mjs');
step('Applying catalog ordering', 'node scripts/apply-catalog-order.mjs --local');
// Production request sync is opt-in — only runs when DEATHCLOCK_SYNC_REQUESTS=1
// is set. This avoids pulling PII (customer name/phone/email/address) into the
// local dev environment on every startup.
if (process.env.DEATHCLOCK_SYNC_REQUESTS === '1') {
  step('Syncing requests from production', 'node scripts/sync-requests.mjs --limit 50');
}

// ── Start dev servers (parallel) ─────────────────────────────
// The worker's `npm run dev` applies migrations + syncs tokens/cookies before
// starting wrangler, so the DB is always up to date on every startup.

console.log('\n🚀 Starting dev servers...\n');

const worker = spawn('npm', ['run', 'dev'], {
  cwd: workerDir,
  stdio: 'inherit',
  shell: true,
});

const client = spawn('npm', ['run', 'dev'], {
  cwd: resolve(root, 'client'),
  stdio: 'inherit',
  shell: true,
});

// Wait for worker to be ready, then verify health
const healthCheck = async () => {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch('http://localhost:8787/health');
      if (res.ok) {
        const data = await res.json();
        console.log(`\n✅ Worker healthy: ${JSON.stringify(data)}`);
        console.log('✅ Client: http://localhost:5173');
        console.log('✅ Worker: http://localhost:8787');
        console.log('\n🎉 Ready to develop!\n');
        return;
      }
    } catch {
      // Not ready yet
    }
  }
  console.warn('\n⚠️  Worker health check timed out after 30s. It may still be starting.');
};

healthCheck().catch(err => {
  console.error('Health check failed:', err);
});

// Clean shutdown
const cleanup = () => {
  worker.kill();
  client.kill();
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// If either process exits, kill the other
worker.on('exit', (code) => {
  console.error(`\n❌ Worker exited${code !== null ? ` with code ${code}` : ''}`);
  client.kill();
  process.exit(code ?? 1);
});

client.on('exit', (code) => {
  console.error(`\n❌ Client exited${code !== null ? ` with code ${code}` : ''}`);
  worker.kill();
  process.exit(code ?? 1);
});
