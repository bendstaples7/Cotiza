#!/usr/bin/env node
/**
 * Local worker dev startup (migrations, token/cookie sync, wrangler dev).
 * Extracted from package.json so npm task detection can parse package.json reliably.
 */
import { execSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd) {
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

run('node scripts/apply-migrations.mjs');
run('node scripts/sync-tokens.mjs');
run('node scripts/sync-cookies.mjs --target local');
run('node scripts/sync-rules.mjs');
run('node scripts/sync-manual-requests.mjs');
run('node scripts/apply-rule-overrides.mjs');
run('node scripts/pull-gmail-secrets.mjs --optional');
run('npx wrangler dev');
