#!/usr/bin/env node
/**
 * Post-deploy pipeline smoke test — shared by the Deploy workflow verify job.
 * Skips gracefully when HEALTHCHECK_KEY repo secret is unset.
 */

const baseUrl = process.env.WORKER_BASE_URL
  ?? 'https://social-media-cross-poster.chicago-reno.workers.dev';
const healthcheckKey = process.env.HEALTHCHECK_KEY ?? '';
const timeoutMs = Number(process.env.HEALTH_CURL_TIMEOUT_MS ?? 10000);

async function main() {
  if (!healthcheckKey.trim()) {
    console.log('HEALTHCHECK_KEY secret not set — skipping pipeline smoke test.');
    console.log("To enable: 'wrangler secret put HEALTHCHECK_KEY' on the worker AND add a repo secret of the same name.");
    return;
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/health/pipelines`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'X-Health-Key': healthcheckKey.trim() },
    });
    const body = await response.text();
    console.log(`Pipelines: ${body}`);

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      console.error(`::error::Pipeline smoke test returned non-JSON: ${body}`);
      process.exit(1);
    }

    if (parsed?.status === 'ok') {
      console.log('Pipeline smoke test passed.');
      return;
    }

    console.error(`::error::Pipeline smoke test failed: ${body}`);
    process.exit(1);
  } catch (err) {
    console.error(`::error::Pipeline smoke test request failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

main();
