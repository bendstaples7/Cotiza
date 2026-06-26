/**
 * Shared permanent-failure classification for retry loops (queue consumer,
 * cross-poster, etc.). Keeps keyword sets and HTTP 4xx patterns in one place.
 */
export function isPermanentErrorMessage(message: string): boolean {
  const msg = message.toLowerCase();
  const keywords = [
    'invalid', 'unauthorized', 'forbidden', 'bad request', 'not found',
    'not configured', 'api key', 'quota', 'insufficient', 'billing',
    'verif', 'content policy', 'safety system',
    'auth', 'permission',
  ];
  if (keywords.some((k) => msg.includes(k))) return true;
  return /\((400|401|403|404)\)/.test(msg);
}

/** Classify an error value as permanent (no retry) or transient. */
export function isPermanentError(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === 'string') return isPermanentErrorMessage(err);
  if (err instanceof Error) return isPermanentErrorMessage(err.message);
  return false;
}
