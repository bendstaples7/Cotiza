import type { Bindings } from './bindings.js';
import {
  getMissingCriticalSecrets,
  getMissingOptionalSecrets,
  type CriticalSecret,
  type OptionalSecret,
} from './config.js';

export type HealthChecks = {
  env: 'ok' | 'degraded';
  gmail: 'ok' | 'missing';
  db: 'ok' | 'error';
};

/** Overall deploy readiness — only critical env + DB gate status. */
export function computeHealthStatus(checks: Pick<HealthChecks, 'env' | 'db'>): 'ok' | 'degraded' {
  return checks.env === 'ok' && checks.db === 'ok' ? 'ok' : 'degraded';
}

function getGmailCheck(env: Bindings): 'ok' | 'missing' {
  return [
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
    env.GMAIL_REFRESH_TOKEN,
  ].every((value) => value?.trim())
    ? 'ok'
    : 'missing';
}

export type HealthReport = {
  status: 'ok' | 'degraded';
  checks: HealthChecks;
  missingEnv: CriticalSecret[];
  optionalMissingEnv: OptionalSecret[];
};

/** Single source of truth for GET /health and deploy-gate tests. */
export function buildHealthReport(env: Bindings, dbOk: boolean): HealthReport {
  const missingEnv = getMissingCriticalSecrets(env);
  const optionalMissingEnv = getMissingOptionalSecrets(env);
  const checks: HealthChecks = {
    env: missingEnv.length > 0 ? 'degraded' : 'ok',
    gmail: getGmailCheck(env),
    db: dbOk ? 'ok' : 'error',
  };

  return {
    status: computeHealthStatus(checks),
    checks,
    missingEnv,
    optionalMissingEnv,
  };
}
