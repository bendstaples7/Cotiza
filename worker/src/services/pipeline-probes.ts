import type { Bindings } from '../bindings.js';
import { EXTERNAL, getGithubRepo } from '../config.js';
import { REQUIRED_D1_TABLES } from '../required-d1-tables.js';
import { buildMediaThumbnailPath, storageKeyFromThumbnailPath } from 'shared';

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export type PipelineProbes = Record<'openai' | 'github' | 'instagram' | 'media' | 'd1', ProbeResult>;

const PROBE_TIMEOUT_MS = 8000;

/** 1×1 PNG (67 bytes) — used for the read-only media delivery probe. */
const PROBE_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const PROBE_STORAGE_KEY = '_healthcheck/media-probe.png';

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI: confirm the API key can see the image model (catches missing/invalid key). */
async function probeOpenAI(env: Bindings): Promise<ProbeResult> {
  if (!env.AI_TEXT_API_KEY?.trim()) return { ok: false, detail: 'AI_TEXT_API_KEY is not set' };
  try {
    const res = await timedFetch(`${EXTERNAL.openai.apiBase}/models/${EXTERNAL.openai.imageModel}`, {
      headers: { Authorization: `Bearer ${env.AI_TEXT_API_KEY}` },
    });
    return res.ok
      ? { ok: true, detail: `model ${EXTERNAL.openai.imageModel} reachable` }
      : { ok: false, detail: `OpenAI returned ${res.status} for ${EXTERNAL.openai.imageModel}` };
  } catch (err) {
    return { ok: false, detail: `OpenAI probe error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

/**
 * GitHub: confirm the cookie-refresh workflow exists and the PAT can read it.
 * Directly catches the repo-slug-drift and missing-PAT-scope failure classes.
 */
async function probeGithub(env: Bindings): Promise<ProbeResult> {
  if (!env.GITHUB_PAT?.trim()) return { ok: false, detail: 'GITHUB_PAT is not set' };
  const repo = getGithubRepo(env);
  const url = `${EXTERNAL.github.apiBase}/repos/${repo}/actions/workflows/${EXTERNAL.github.cookieRefreshWorkflow}`;
  try {
    const res = await timedFetch(url, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'cotiza-worker-healthcheck',
      },
    });
    return res.ok
      ? { ok: true, detail: `workflow reachable in ${repo}` }
      : { ok: false, detail: `GitHub returned ${res.status} for ${repo} (check GITHUB_REPO / PAT scope)` };
  } catch (err) {
    return { ok: false, detail: `GitHub probe error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

/** Instagram: confirm the Page token can read the business account (read-only). */
async function probeInstagram(env: Bindings): Promise<ProbeResult> {
  const token = env.FB_PAGE_ACCESS_TOKEN?.trim();
  const account = env.IG_BUSINESS_ACCOUNT_ID?.trim();
  if (!token || !account) {
    return { ok: false, detail: 'FB_PAGE_ACCESS_TOKEN / IG_BUSINESS_ACCOUNT_ID not set' };
  }
  const url = `${EXTERNAL.graph.base}/${account}?fields=id&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await timedFetch(url);
    return res.ok
      ? { ok: true, detail: 'Graph account reachable' }
      : { ok: false, detail: `Graph returned ${res.status} (token/account invalid)` };
  } catch (err) {
    return { ok: false, detail: `Instagram probe error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

/**
 * Media delivery: write a tiny PNG to R2, verify the thumbnail path mapping,
 * and (when selfUrl is provided) fetch it through the public /media/thumbnail route.
 * Catches "images saved but img tags 404" regressions.
 */
async function probeMediaDelivery(env: Bindings, selfUrl?: string): Promise<ProbeResult> {
  if (!env.R2_BUCKET) {
    return { ok: false, detail: 'R2_BUCKET binding is not configured' };
  }

  const thumbnailPath = buildMediaThumbnailPath(PROBE_STORAGE_KEY);
  if (storageKeyFromThumbnailPath(thumbnailPath) !== PROBE_STORAGE_KEY) {
    return { ok: false, detail: 'thumbnail path mapping is broken' };
  }

  try {
    await env.R2_BUCKET.put(PROBE_STORAGE_KEY, PROBE_PNG, {
      httpMetadata: { contentType: 'image/png' },
    });

    const object = await env.R2_BUCKET.get(PROBE_STORAGE_KEY);
    if (!object) {
      return { ok: false, detail: 'R2 write succeeded but read returned null' };
    }

    const bytes = await object.arrayBuffer();
    if (bytes.byteLength === 0) {
      return { ok: false, detail: 'R2 probe object is empty' };
    }

    if (selfUrl) {
      const origin = new URL(selfUrl).origin;
      const res = await timedFetch(`${origin}${thumbnailPath}`);
      if (!res.ok) {
        return { ok: false, detail: `GET ${thumbnailPath} returned ${res.status}` };
      }
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        return { ok: false, detail: `GET ${thumbnailPath} returned unexpected content-type: ${contentType}` };
      }
      const body = await res.arrayBuffer();
      if (body.byteLength === 0) {
        return { ok: false, detail: `GET ${thumbnailPath} returned empty body` };
      }
      return { ok: true, detail: 'R2 + public thumbnail route reachable' };
    }

    return { ok: true, detail: 'R2 read + thumbnail path mapping ok' };
  } catch (err) {
    return { ok: false, detail: `Media probe error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

/** D1: confirm critical tables exist (catches schema drift after bad migration edits). */
async function probeD1(env: Bindings): Promise<ProbeResult> {
  if (!env.DB) {
    return { ok: false, detail: 'DB binding is not configured' };
  }

  try {
    const missing: string[] = [];
    for (const table of REQUIRED_D1_TABLES) {
      const row = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).bind(table).first<{ name: string }>();
      if (!row) {
        missing.push(table);
      }
    }

    if (missing.length > 0) {
      return { ok: false, detail: `missing tables: ${missing.join(', ')}` };
    }

    return { ok: true, detail: `${REQUIRED_D1_TABLES.length} required tables present` };
  } catch (err) {
    return { ok: false, detail: `D1 probe error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

/**
 * Run all read-only pipeline connectivity probes in parallel. Safe to call
 * repeatedly (writes a tiny healthcheck object to R2). Exposed via the guarded
 * GET /health/pipelines.
 *
 * @param selfUrl Pass the incoming request URL so the media probe can round-trip
 *   through the public /media/thumbnail route on the deployed worker.
 */
export async function runPipelineProbes(env: Bindings, selfUrl?: string): Promise<PipelineProbes> {
  const [openai, github, instagram, media, d1] = await Promise.all([
    probeOpenAI(env),
    probeGithub(env),
    probeInstagram(env),
    probeMediaDelivery(env, selfUrl),
    probeD1(env),
  ]);
  return { openai, github, instagram, media, d1 };
}
