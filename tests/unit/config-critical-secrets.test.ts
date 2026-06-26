import { describe, it, expect } from 'vitest';
import {
  CRITICAL_SECRETS,
  OPTIONAL_SECRETS,
  SECRETS_FORBIDDEN_IN_CRITICAL,
  getMissingCriticalSecrets,
  getMissingOptionalSecrets,
} from '../../worker/src/config.js';

describe('getMissingCriticalSecrets', () => {
  const fullEnv = Object.fromEntries(CRITICAL_SECRETS.map((key) => [key, 'set'])) as never;

  it('returns empty when all critical secrets are present', () => {
    expect(getMissingCriticalSecrets(fullEnv)).toEqual([]);
  });

  it('does not require Instagram OAuth credentials (direct-token mode)', () => {
    const missing = getMissingCriticalSecrets({
      ...fullEnv,
      INSTAGRAM_CLIENT_ID: '',
      INSTAGRAM_CLIENT_SECRET: '',
    } as never);

    expect(missing).toEqual([]);
    expect(CRITICAL_SECRETS).not.toContain('INSTAGRAM_CLIENT_ID');
    expect(CRITICAL_SECRETS).not.toContain('INSTAGRAM_CLIENT_SECRET');
  });

  it('reports missing core secrets by name', () => {
    expect(getMissingCriticalSecrets({ ...fullEnv, AI_TEXT_API_KEY: '' } as never)).toEqual([
      'AI_TEXT_API_KEY',
    ]);
  });
});

describe('getMissingOptionalSecrets', () => {
  it('reports missing optional secrets by name', () => {
    const env = Object.fromEntries(OPTIONAL_SECRETS.map((key) => [key, 'set'])) as never;
    env.INSTAGRAM_CLIENT_ID = '';

    expect(getMissingOptionalSecrets(env)).toEqual(['INSTAGRAM_CLIENT_ID']);
  });
});

describe('SECRETS_FORBIDDEN_IN_CRITICAL guard', () => {
  it('blocks OAuth vars from ever re-entering the deploy-critical list', () => {
    for (const key of SECRETS_FORBIDDEN_IN_CRITICAL) {
      expect(CRITICAL_SECRETS).not.toContain(key);
    }
  });

  it('every forbidden secret is tracked as optional', () => {
    for (const key of SECRETS_FORBIDDEN_IN_CRITICAL) {
      expect(OPTIONAL_SECRETS).toContain(key);
    }
  });
});
