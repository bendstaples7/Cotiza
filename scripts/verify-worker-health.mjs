#!/usr/bin/env node
/**
 * Post-deploy health gate — shared by the Deploy workflow verify job.
 * Polls WORKER_HEALTH_URL until status=ok or retries are exhausted.
 *
 * Usage:
 *   node scripts/verify-worker-health.mjs
 *   WORKER_HEALTH_URL=https://.../health node scripts/verify-worker-health.mjs
 */

const url = process.env.WORKER_HEALTH_URL
  ?? 'https://social-media-cross-poster.chicago-reno.workers.dev/health';
const maxAttempts = Number(process.env.HEALTH_MAX_ATTEMPTS ?? 5);
const sleepMs = Number(process.env.HEALTH_RETRY_SLEEP_MS ?? 5000);
const timeoutMs = Number(process.env.HEALTH_CURL_TIMEOUT_MS ?? 10000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    return { httpOk: response.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let last = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await sleep(sleepMs);
    }

    let parsed;
    try {
      const { httpOk, body } = await fetchHealth();
      last = body;
      if (!httpOk) {
        console.log(`Attempt ${attempt}: HTTP not ok`);
        continue;
      }
      parsed = JSON.parse(body);
    } catch (err) {
      console.log(`Attempt ${attempt}: ${err instanceof Error ? err.message : 'fetch failed'}`);
      continue;
    }

    const status = parsed?.status ?? 'unknown';
    if (status === 'ok') {
      console.log(`Health OK on attempt ${attempt}: ${last}`);
      return;
    }

    const missing = parsed?.missingEnv?.join(', ') ?? 'none';
    const optional = parsed?.optionalMissingEnv?.join(', ') ?? 'none';
    console.log(`Attempt ${attempt}: status=${status} missingEnv=[${missing}] optionalMissingEnv=[${optional}]`);
  }

  console.error(`::error::Worker /health is not ok after ${maxAttempts} attempts. Last response: ${last}`);
  process.exit(1);
}

main();
