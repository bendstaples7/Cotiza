#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

// Read Cloudflare API token from .dev.vars
const devVars = readFileSync('/home/jeffreyops/Cotiza/worker/.dev.vars', 'utf8');
const env = {};
for (const line of devVars.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  env[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
}

const cfToken = env.CLOUDFLARE_API_TOKEN;

// Query remote D1
const cmd = `CLOUDFLARE_API_TOKEN=*** ${cfToken} npx wrangler d1 execute DB --remote --json --command "SELECT access_token, refresh_token, updated_at FROM jobber_tokens WHERE id = 'default'"`;

const output = execSync(cmd, {
  cwd: '/home/jeffreyops/Cotiza/worker',
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 60000,
  shell: '/usr/bin/bash',
});

const parsed = JSON.parse(output);
const results = parsed[0]?.results || [];
if (results.length === 0) {
  console.error('No tokens found in remote D1');
  process.exit(1);
}

const { access_token, refresh_token, updated_at } = results[0];

// Export the token as a variable so we can source this
console.log(`ACCESS_TOKEN=${access_token}`);
console.log(`REFRESH_TOKEN=${refresh_token}`);
console.log(`UPDATED_AT=${updated_at}`);