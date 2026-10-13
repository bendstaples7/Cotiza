/**
 * Turn Jobber / cookie-refresh log text into something safe to store.
 * Keeps short error codes. Strips tokens, cookies, and secret fragments.
 */

const SENSITIVE_KEYS = new Set([
  'access_token',
  'refresh_token',
  'client_secret',
  'client_id',
  'id_token',
  'password',
  'authorization',
  'cookie',
  'cookies',
  'set-cookie',
  'code',
  'token',
]);

function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object' && typeof value.message === 'string') {
    const stderr = typeof value.stderr === 'string' ? value.stderr : '';
    return stderr ? `${value.message}\n${stderr}` : value.message;
  }
  return String(value);
}

function knownSecrets(secrets) {
  const list = Array.isArray(secrets) ? secrets : [];
  return list
    .filter((secret) => typeof secret === 'string' && secret.length >= 8)
    .sort((a, b) => b.length - a.length);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} [secrets] live credentials to strip, including prefixes and suffixes
 * @returns {string}
 */
export function sanitizeLogText(value, secrets = []) {
  let text = asText(value);

  for (const secret of knownSecrets(secrets)) {
    text = text.split(secret).join('[redacted]');
    const prefix = secret.slice(0, 15);
    const suffix = secret.slice(-8);
    if (prefix.length >= 8) text = text.split(prefix).join('[redacted]');
    if (suffix.length >= 8 && suffix !== prefix) text = text.split(suffix).join('[redacted]');
  }

  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  text = text.replace(/\b(gh[pousr]_[A-Za-z0-9]{8,})\b/g, '[redacted]');
  text = text.replace(
    /\b(access_token|refresh_token|client_secret|client_id|id_token|password|authorization|cookie|cookies|set-cookie)\b(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s&,"']+)/gi,
    '$1$2[redacted]',
  );
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  text = text.replace(/[A-Za-z0-9+/_=-]{20,}/g, (match) => {
    if (/[A-Za-z]/.test(match) && /\d/.test(match)) return '[redacted]';
    return match;
  });
  return text;
}

function safeMessage(value) {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  return sanitizeLogText(value).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function summarizeJson(json) {
  if (json == null || typeof json !== 'object') return 'non-object body';
  if (Array.isArray(json)) return `array length=${json.length}`;

  const parts = [];
  if (typeof json.error === 'string' || typeof json.error === 'number') {
    parts.push(`error=${safeMessage(String(json.error))}`);
  }
  if (typeof json.error_description === 'string') {
    parts.push(`error_description=${safeMessage(json.error_description)}`);
  }
  if (typeof json.message === 'string') {
    parts.push(`message=${safeMessage(json.message)}`);
  }
  if (Array.isArray(json.errors)) {
    const messages = json.errors.slice(0, 3).map((entry) => safeMessage(entry?.message || entry?.code));
    parts.push(`errors=${json.errors.length} [${messages.join('; ')}]`);
  }
  if (parts.length === 0) {
    const keys = Object.keys(json)
      .filter((key) => !SENSITIVE_KEYS.has(key.toLowerCase()))
      .slice(0, 8);
    parts.push(`keys=${keys.join(',') || 'none'}`);
  }
  return parts.join(' ');
}

/**
 * Short description of an upstream error body. Does not echo the raw payload.
 * @param {string} body
 * @param {readonly string[]} [secrets]
 */
export function summarizeUpstreamBody(body, secrets = []) {
  const raw = typeof body === 'string' ? body : '';
  let summary = 'empty body';
  if (raw.trim()) {
    try {
      summary = summarizeJson(JSON.parse(raw));
    } catch {
      summary = `non-json body (${raw.length} bytes)`;
    }
  }
  return sanitizeLogText(summary, secrets);
}

/** @param {string} query */
export function graphqlOperationName(query) {
  const match = String(query || '').match(/\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return match ? match[1] : 'anonymous';
}

/**
 * @param {string} prefix
 * @param {unknown} detail
 * @param {readonly string[]} [secrets]
 */
export function formatLog(prefix, detail, secrets = []) {
  return `${prefix} ${sanitizeLogText(detail, secrets)}`.trim();
}
