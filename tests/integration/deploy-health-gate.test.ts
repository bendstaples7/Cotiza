import { describe, it, expect } from 'vitest';
import {
  CRITICAL_SECRETS,
  OPTIONAL_SECRETS,
  SECRETS_FORBIDDEN_IN_CRITICAL,
  getMissingCriticalSecrets,
  getMissingOptionalSecrets,
} from '../../worker/src/config.js';
import { buildHealthReport } from '../../worker/src/health-status.js';

/** Mirrors production direct-token Instagram + Jobber setup (no OAuth app creds). */
function productionLikeEnv(overrides: Record<string, unknown> = {}) {
  return {
    AI_TEXT_API_KEY: 'sk-prod',
    CHANNEL_ENCRYPTION_KEY: 'a'.repeat(64),
    FB_PAGE_ACCESS_TOKEN: 'fb-page-token',
    IG_BUSINESS_ACCOUNT_ID: 'ig-business-1',
    JOBBER_CLIENT_ID: 'jobber-client',
    JOBBER_CLIENT_SECRET: 'jobber-secret',
    JOBBER_ACCESS_TOKEN: 'jobber-access',
    JOBBER_REFRESH_TOKEN: 'jobber-refresh',
    INSTAGRAM_CLIENT_ID: '',
    INSTAGRAM_CLIENT_SECRET: '',
    GITHUB_PAT: '',
    GMAIL_CLIENT_ID: '',
    GMAIL_CLIENT_SECRET: '',
    GMAIL_REFRESH_TOKEN: '',
    ...overrides,
  } as never;
}

describe('deploy health gate (pre-merge CI simulation)', () => {
  it('production-like secrets pass the deploy gate (status ok)', () => {
    const report = buildHealthReport(productionLikeEnv(), true);

    expect(report.status).toBe('ok');
    expect(report.checks.env).toBe('ok');
    expect(report.checks.db).toBe('ok');
    expect(report.missingEnv).toEqual([]);
    expect(report.optionalMissingEnv).toContain('INSTAGRAM_CLIENT_ID');
    expect(report.optionalMissingEnv).toContain('INSTAGRAM_CLIENT_SECRET');
  });

  it('missing Gmail does not block deploy readiness', () => {
    const report = buildHealthReport(productionLikeEnv(), true);

    expect(report.checks.gmail).toBe('missing');
    expect(report.status).toBe('ok');
  });

  it('missing a critical secret fails the deploy gate', () => {
    const report = buildHealthReport(
      productionLikeEnv({ AI_TEXT_API_KEY: '' }),
      true,
    );

    expect(report.status).toBe('degraded');
    expect(report.missingEnv).toEqual(['AI_TEXT_API_KEY']);
  });

  it('DB failure fails the deploy gate even when env is ok', () => {
    const report = buildHealthReport(productionLikeEnv(), false);

    expect(report.status).toBe('degraded');
    expect(report.checks.db).toBe('error');
  });
});

describe('secret tier guardrails', () => {
  it('forbidden OAuth secrets are not in CRITICAL_SECRETS', () => {
    for (const key of SECRETS_FORBIDDEN_IN_CRITICAL) {
      expect(CRITICAL_SECRETS).not.toContain(key);
      expect(OPTIONAL_SECRETS).toContain(key);
    }
  });

  it('critical and optional lists do not overlap', () => {
    const overlap = CRITICAL_SECRETS.filter((key) =>
      (OPTIONAL_SECRETS as readonly string[]).includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it('getMissingOptionalSecrets reports OAuth vars without affecting critical list', () => {
    const env = productionLikeEnv();
    expect(getMissingCriticalSecrets(env)).toEqual([]);
    expect(getMissingOptionalSecrets(env)).toEqual(
      expect.arrayContaining(['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET']),
    );
  });
});
