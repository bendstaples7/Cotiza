import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Creates only the dedicated receipt bucket; never enables public access. */
export async function ensurePrivateReceiptsBucket({ accountId, token, bucketName, fetchImpl = fetch }) {
  if (!accountId || !token || !bucketName) throw new Error('Receipt bucket provisioning requires the configured account, bucket and deployment token.');
  const root = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function read(path, init = {}) {
    const res = await fetchImpl(root + path, { ...init, headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Receipt bucket operation failed (HTTP ${res.status}). Check R2 permissions on the deployment token.`);
    const data = await res.json(); if (!data.success) throw new Error('Receipt bucket operation was rejected.'); return data.result;
  }
  const existing = await fetchImpl(`${root}/${encodeURIComponent(bucketName)}`, { headers, signal: AbortSignal.timeout(15000) });
  if (existing.status === 404) await read('', { method: 'POST', body: JSON.stringify({ name: bucketName }) });
  else if (!existing.ok) throw new Error(`Could not inspect receipt bucket (HTTP ${existing.status}). No bucket was created.`);
  const managed = await read(`/${encodeURIComponent(bucketName)}/domains/managed`);
  const custom = await read(`/${encodeURIComponent(bucketName)}/domains/custom`);
  if (managed?.enabled !== false || !Array.isArray(custom?.domains) || custom.domains.some(domain => domain.enabled)) throw new Error('Receipt bucket public access is enabled or could not be verified. Deployment stopped; no receipts were uploaded.');
  return { private: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
    const accountId = config.match(/^account_id\s*=\s*"([^"]+)"/m)?.[1];
    const bucketName = config.match(/binding\s*=\s*"ASSISTANT_RECEIPTS_BUCKET"\s*\n\s*bucket_name\s*=\s*"([^"]+)"/)?.[1];
    await ensurePrivateReceiptsBucket({ accountId, token: process.env.CLOUDFLARE_API_TOKEN, bucketName });
    console.log('Dedicated receipt bucket exists and public access is disabled.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
