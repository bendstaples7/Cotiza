import { describe, expect, it } from 'vitest';
import type { SystemsStatusResponse } from 'shared';
import { evaluateSystemsStatus } from '../../client/src/AuthContext';

function base(overrides: Partial<SystemsStatusResponse> = {}): SystemsStatusResponse {
  return {
    jobber: {
      available: true,
      webhookActive: false,
      read: {
        status: 'live',
        source: 'live',
        fetchedAt: '2026-03-01T00:00:00.000Z',
        liveLookupFailed: false,
      },
    },
    jobberSession: { configured: true, expired: false },
    instagram: { status: 'connected', accountName: 'Chicago Reno' },
    ...overrides,
  };
}

describe('evaluateSystemsStatus', () => {
  it('blocks login when the Jobber live read failed', () => {
    const status = evaluateSystemsStatus(base({
      jobber: {
        available: false,
        webhookActive: true,
        read: {
          status: 'failed',
          source: 'none',
          fetchedAt: null,
          liveLookupFailed: true,
          error: { code: 'auth', message: 'Jobber access token is unavailable.' },
        },
      },
    }));
    expect(status).toEqual({ state: 'jobber_unavailable' });
  });

  it('blocks login when liveLookupFailed is true even if available were true', () => {
    const status = evaluateSystemsStatus(base({
      jobber: {
        available: true,
        webhookActive: false,
        read: {
          status: 'failed',
          source: 'webhook',
          fetchedAt: null,
          liveLookupFailed: true,
          error: { code: 'network', message: 'Network error.' },
        },
      },
    }));
    expect(status).toEqual({ state: 'jobber_unavailable' });
  });

  it('continues to session and Instagram checks when Jobber read is healthy', () => {
    expect(evaluateSystemsStatus(base({
      jobberSession: { configured: false, expired: false },
    }))).toEqual({ state: 'jobber_session_expired' });

    expect(evaluateSystemsStatus(base({
      instagram: { status: 'not_connected' },
    }))).toEqual({
      state: 'instagram_issue',
      instagram: { status: 'not_connected' },
    });

    expect(evaluateSystemsStatus(base())).toEqual({ state: 'ready' });
  });
});
