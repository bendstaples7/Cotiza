import type { Bindings } from './bindings.js';
import { PlatformError } from './errors/index.js';

/**
 * Centralized configuration.
 *
 * Two classes of value that previously caused production incidents live here so
 * they cannot silently drift across the codebase:
 *
 *  1. External service identifiers (API hosts, repo slug, model names). A
 *     hardcoded repo slug in a route once dispatched to the wrong repository;
 *     keeping every identifier in one module (enforced by ESLint) prevents that.
 *  2. The set of secrets required for the worker's core pipelines, so `/health`
 *     and request handlers validate against a single source of truth.
 */

/** External service identifiers — the single source of truth. */
export const EXTERNAL = {
  github: {
    apiBase: 'https://api.github.com',
    /** Canonical repo for this project; override per-env via the GITHUB_REPO var. */
    defaultRepo: 'bendstaples7/chicago-reno-social-generator',
    cookieRefreshWorkflow: 'refresh-jobber-cookies.yml',
    workflowRef: 'main',
  },
  openai: {
    imageModel: 'gpt-image-1',
    chatModel: 'gpt-4o-mini',
    imageUrl: 'https://api.openai.com/v1/images/generations',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    /** Base used for read-only health probes (e.g. GET /v1/models/<model>). */
    apiBase: 'https://api.openai.com/v1',
  },
  graph: {
    /** Facebook Graph API base used for Instagram publishing + health probes. */
    base: 'https://graph.facebook.com/v25.0',
  },
} as const;

/**
 * Secrets that MUST be present (non-empty) for the worker's core pipelines to
 * function. Surfaced by NAME (never value) via `/health`.
 *
 * Instagram OAuth credentials (`INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET`)
 * are intentionally excluded — production uses direct-token mode
 * (`FB_PAGE_ACCESS_TOKEN` + `IG_BUSINESS_ACCOUNT_ID`). OAuth vars are only
 * needed when connecting accounts via the in-app OAuth flow.
 */
export const CRITICAL_SECRETS = [
  'AI_TEXT_API_KEY',
  'CHANNEL_ENCRYPTION_KEY',
  'FB_PAGE_ACCESS_TOKEN',
  'IG_BUSINESS_ACCOUNT_ID',
  'JOBBER_CLIENT_ID',
  'JOBBER_CLIENT_SECRET',
  'JOBBER_ACCESS_TOKEN',
  'JOBBER_REFRESH_TOKEN',
] as const satisfies readonly (keyof Bindings)[];

export type CriticalSecret = (typeof CRITICAL_SECRETS)[number];

/**
 * Secrets that enable optional features. Reported in `/health` as
 * `optionalMissingEnv` but never block deploy readiness.
 */
export const OPTIONAL_SECRETS = [
  'INSTAGRAM_CLIENT_ID',
  'INSTAGRAM_CLIENT_SECRET',
  'GITHUB_PAT',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  'HEALTHCHECK_KEY',
  'JOBBER_WEB_EMAIL',
  'JOBBER_WEB_PASSWORD',
] as const satisfies readonly (keyof Bindings)[];

export type OptionalSecret = (typeof OPTIONAL_SECRETS)[number];

/**
 * Guard list: these must never appear in CRITICAL_SECRETS (enforced by unit test).
 * Production uses direct-token Instagram publishing without OAuth app credentials.
 */
export const SECRETS_FORBIDDEN_IN_CRITICAL = [
  'INSTAGRAM_CLIENT_ID',
  'INSTAGRAM_CLIENT_SECRET',
] as const satisfies readonly (keyof Bindings)[];

export type ForbiddenCriticalSecret = (typeof SECRETS_FORBIDDEN_IN_CRITICAL)[number];

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

/** Return the names of any missing/empty critical secrets. */
export function getMissingCriticalSecrets(env: Bindings): CriticalSecret[] {
  return CRITICAL_SECRETS.filter((key) => isBlank(env[key]));
}

/** Return the names of any missing/empty optional secrets. */
export function getMissingOptionalSecrets(env: Bindings): OptionalSecret[] {
  return OPTIONAL_SECRETS.filter((key) => isBlank(env[key]));
}

/** Resolve the GitHub repo slug for workflow dispatch (configurable, defaulted). */
export function getGithubRepo(env: Bindings): string {
  return (env.GITHUB_REPO || '').trim() || EXTERNAL.github.defaultRepo;
}

/** Build the cookie-refresh workflow dispatch URL from config. */
export function getCookieRefreshDispatchUrl(env: Bindings): string {
  const { apiBase, cookieRefreshWorkflow } = EXTERNAL.github;
  return `${apiBase}/repos/${getGithubRepo(env)}/actions/workflows/${cookieRefreshWorkflow}/dispatches`;
}

/**
 * Throw a clear PlatformError when any of the given env keys are missing/empty.
 * Reports NAMES only — never logs or returns secret values.
 */
export function assertConfigured(
  env: Bindings,
  keys: readonly (keyof Bindings)[],
  component: string,
): void {
  const missing = keys.filter((key) => isBlank(env[key]));
  if (missing.length > 0) {
    throw new PlatformError({
      severity: 'error',
      component,
      operation: 'config',
      description: `Required configuration is missing: ${missing.join(', ')}.`,
      recommendedActions: [
        `Set ${missing.join(', ')} in the Worker secrets (wrangler secret put <NAME>)`,
        'See docs/production-deploy-checklist.md',
      ],
      statusCode: 503,
    });
  }
}
