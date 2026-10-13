import type { SystemsStatusResponse } from 'shared';

export type SystemsStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ready' }
  | { state: 'jobber_unavailable' }
  | { state: 'jobber_session_expired' }
  | { state: 'instagram_issue'; instagram: { status: 'expired' | 'not_connected'; accountName?: string } }
  | { state: 'error'; message: string };

export function evaluateSystemsStatus(response: SystemsStatusResponse): SystemsStatus {
  const read = response.jobber.read;
  const jobberDown = !response.jobber.available
    || read.liveLookupFailed
    || read.status === 'failed';
  if (jobberDown) {
    return { state: 'jobber_unavailable' };
  }
  /*
   * CRITICAL — BLOCKING GATE: Jobber session cookies are REQUIRED.
   * The app cannot fetch customer request form submissions without them.
   * This MUST return a blocking state — do NOT change to a non-blocking/skippable state.
   * See .kiro/steering/product.md "Jobber API Limitations" for full context.
   */
  if (!response.jobberSession.configured || response.jobberSession.expired) {
    return { state: 'jobber_session_expired' };
  }
  if (response.instagram.status === 'expired' || response.instagram.status === 'not_connected') {
    return {
      state: 'instagram_issue',
      instagram: { status: response.instagram.status, accountName: response.instagram.accountName },
    };
  }
  return { state: 'ready' };
}
