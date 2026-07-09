/**
 * Tables that must exist in production D1 for critical OAuth and systems-check flows.
 * Checked by the /health/pipelines d1 probe after deploy.
 */
export const REQUIRED_D1_TABLES = [
  'oauth_states',
  'users',
  'jobber_tokens',
  'jobber_web_session',
  'channel_connections',
] as const;
