/**
 * Scheduled handler that keeps the Jobber web session alive.
 * Runs on a Cloudflare Cron Trigger (see JOBBER_SESSION_KEEPALIVE_CRON) so the
 * session is checked against Jobber without a browser login. GitHub Actions
 * login (refresh-jobber-cookies.yml) stays the fallback when Jobber rejects it.
 */

import type { Bindings } from '../bindings.js';
import { JobberWebSession } from '../services/jobber-web-session.js';

/** Must match the cron listed in wrangler.toml [triggers]. */
export const JOBBER_SESSION_KEEPALIVE_CRON = '*/30 * * * *';

export async function handleJobberSessionKeepAlive(env: Bindings): Promise<void> {
  const result = await new JobberWebSession(env.DB).keepAlive();
  console.log(`[scheduled] Jobber session keep-alive result=${result}`);
}
