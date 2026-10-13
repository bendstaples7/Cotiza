/**
 * Local client for the Cotiza operations assistant.
 *
 * This performs the same sign-in ChatGPT uses: authorization code + PKCE,
 * then discovers tools and reads one request with its quotes.
 * It does not print tokens, notes, or customer names.
 *
 *   OPS_ASSISTANT_BASE_URL=http://127.0.0.1:8787 OPS_ASSISTANT_EMAIL=you@chicago-reno.com node scripts/ops-assistant-exercise.mjs
 *
 * OPS_ASSISTANT_TOKEN skips sign-in and uses a token you already have.
 * OPS_ASSISTANT_REQUEST_ID reads that request. Otherwise the first request on the page is used.
 */

import { createHash, randomBytes } from 'node:crypto';

const base = (process.env.OPS_ASSISTANT_BASE_URL || '').replace(/\/$/, '');
const email = process.env.OPS_ASSISTANT_EMAIL || '';
let token = process.env.OPS_ASSISTANT_TOKEN || '';
const requestedId = process.env.OPS_ASSISTANT_REQUEST_ID || '';

if (!base || (!token && !email)) {
  console.log('Set OPS_ASSISTANT_BASE_URL and either OPS_ASSISTANT_EMAIL or OPS_ASSISTANT_TOKEN.');
  process.exit(1);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function oauthLogin() {
  const redirectUri = `${base}/oauth/exercise-callback`;
  const resource = `${base}/mcp`;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', 'cotiza-ops-local');
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('resource', resource);
  authorize.searchParams.set('scope', 'ops:read');
  authorize.searchParams.set('state', 'exercise');

  const loginPage = await fetch(authorize);
  const loginHtml = await loginPage.text();
  const tx = loginHtml.match(/name="tx" value="([^"]+)"/)?.[1];
  if (!loginPage.ok || !tx) fail(`Sign-in page was not usable (HTTP ${loginPage.status}).`);

  const consent = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tx, email }),
  });
  const consentHtml = await consent.text();
  if (!consent.ok || !consentHtml.includes('Allow read access')) {
    fail(`Sign-in did not reach read-only consent (HTTP ${consent.status}).`);
  }

  const allowed = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tx, decision: 'allow' }),
  });
  const location = allowed.headers.get('location');
  if (!location) fail(`Allow did not redirect (HTTP ${allowed.status}).`);
  const back = new URL(location, base);
  if (back.searchParams.get('iss') !== new URL(base).origin) fail('Authorization response issuer did not match.');
  if (back.searchParams.get('state') !== 'exercise') fail('Authorization state did not match.');
  const code = back.searchParams.get('code');
  if (!code) fail(`Authorization failed: ${back.searchParams.get('error') || 'no code'}`);

  const traded = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'cotiza-ops-local',
      redirect_uri: redirectUri,
      resource,
    }),
  });
  const issued = await traded.json();
  if (!traded.ok || !issued.access_token || !issued.refresh_token) fail('Code was not exchanged for a token.');
  console.log('oauth: code exchanged for a read token');
  return issued;
}

async function rpc(accessToken, method, params) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    fail(`${method} failed (HTTP ${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}).`);
  }
  return body;
}

function toolPayload(body) {
  const text = body?.result?.content?.[0]?.text;
  if (!text) fail('Tool result was missing.');
  return JSON.parse(text);
}

if (!token) {
  const issued = await oauthLogin();
  token = issued.access_token;

  const refreshed = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: issued.refresh_token,
      resource: `${base}/mcp`,
    }),
  });
  const next = await refreshed.json();
  if (!refreshed.ok || !next.access_token) fail('Refresh did not return a new token.');
  token = next.access_token;
  console.log('oauth: refresh returned a new read token');
}

const listed = await rpc(token, 'tools/list');
const names = (listed.result?.tools || []).map((tool) => tool.name);
console.log(`tools: ${names.join(', ')}`);
for (const required of ['find_requests', 'read_request', 'find_quotes', 'read_quote', 'list_request_quotes']) {
  if (!names.includes(required)) fail(`Missing tool ${required}.`);
}

let requestId = requestedId;
if (!requestId) {
  const found = toolPayload(await rpc(token, 'tools/call', { name: 'find_requests', arguments: { limit: 5 } }));
  console.log(`find_requests: outcome=${found.outcome} status=${found.read?.status} liveLookupFailed=${found.read?.liveLookupFailed} count=${found.items?.length ?? 0} next=${found.page?.hasNextPage}`);
  if (found.outcome !== 'ok' || !found.items?.[0]?.id) fail('No live request was available to read.');
  requestId = found.items[0].id;
}

const detail = toolPayload(await rpc(token, 'tools/call', { name: 'read_request', arguments: { requestId } }));
console.log(`read_request: outcome=${detail.outcome} status=${detail.read?.status} liveLookupFailed=${detail.read?.liveLookupFailed} notes=${detail.request?.notes?.length ?? 0} attachments=${detail.request?.attachments?.length ?? 0}`);
if (detail.outcome !== 'ok') fail('Reading the request did not succeed.');

const linked = toolPayload(await rpc(token, 'tools/call', { name: 'list_request_quotes', arguments: { requestId } }));
console.log(`list_request_quotes: jobber=${linked.jobberQuotes?.outcome} liveLookupFailed=${linked.jobberQuotes?.read?.liveLookupFailed} quotes=${linked.jobberQuotes?.items?.length ?? 0} drafts=${linked.cotizaDrafts?.outcome} draftCount=${linked.cotizaDrafts?.items?.length ?? 0}`);
if (linked.jobberQuotes?.outcome === 'failed') fail('Quote lookup failed.');

if (!requestedId && (linked.jobberQuotes?.items?.length ?? 0) === 0) {
  const quotes = toolPayload(await rpc(token, 'tools/call', { name: 'find_quotes', arguments: { limit: 5 } }));
  const linkedRequest = (quotes.items || []).find((item) => item.requestId?.availability === 'present');
  console.log(`find_quotes: outcome=${quotes.outcome} status=${quotes.read?.status} liveLookupFailed=${quotes.read?.liveLookupFailed} count=${quotes.items?.length ?? 0}`);
  if (quotes.outcome !== 'ok') fail('Finding quotes did not succeed.');
  if (linkedRequest) {
    const quoteId = linkedRequest.id;
    const again = toolPayload(await rpc(token, 'tools/call', {
      name: 'list_request_quotes',
      arguments: { requestId: linkedRequest.requestId.value },
    }));
    const readQuote = toolPayload(await rpc(token, 'tools/call', { name: 'read_quote', arguments: { quoteId } }));
    console.log(`linked request quotes: jobber=${again.jobberQuotes?.outcome} liveLookupFailed=${again.jobberQuotes?.read?.liveLookupFailed} quotes=${again.jobberQuotes?.items?.length ?? 0} drafts=${again.cotizaDrafts?.outcome}`);
    console.log(`read_quote: outcome=${readQuote.outcome} status=${readQuote.read?.status} liveLookupFailed=${readQuote.read?.liveLookupFailed}`);
    if (again.jobberQuotes?.outcome === 'failed' || readQuote.outcome !== 'ok') fail('A quote linked to a request could not be read.');
  }
}

if (email) {
  await fetch(`${base}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  const rejected = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  console.log(`revoked token: HTTP ${rejected.status}`);
  if (rejected.status !== 401) fail('Revoked token was still accepted.');
}
