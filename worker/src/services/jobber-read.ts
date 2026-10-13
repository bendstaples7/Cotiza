import { PlatformError } from '../errors/index.js';
import type {
  JobberReadError,
  JobberReadMeta,
  JobberReadResult,
  JobberReadStatus,
} from 'shared';

export function classifyJobberReadError(err: unknown): JobberReadError {
  const message = err instanceof Error ? err.message : 'Unknown Jobber error';

  if (err instanceof PlatformError) {
    if (/not configured/i.test(message)) return { code: 'unavailable', message };
    if (/access token|unauthor|forbidden|re-author|credential/i.test(message)) {
      return { code: 'auth', message };
    }
    return { code: 'unavailable', message };
  }

  if (err instanceof Error && (err.name === 'AbortError' || /timed out/i.test(message))) {
    return { code: 'timeout', message };
  }
  if (/throttl/i.test(message)) return { code: 'throttled', message };
  if (/graphql/i.test(message)) return { code: 'graphql', message };
  if (/\b401\b|\b403\b|unauthorized|forbidden|access token|re-author/i.test(message)) {
    return { code: 'auth', message };
  }
  if (/\bd1\b|database|sqlite/i.test(message)) return { code: 'database', message };
  if (/fetch failed|network|econn|enotfound|socket/i.test(message)) {
    return { code: 'network', message };
  }
  return { code: 'network', message };
}

export function liveJobberRead<T>(records: T[], fetchedAt = new Date().toISOString()): JobberReadResult<T> {
  const status: JobberReadStatus = records.length > 0 ? 'live' : 'empty';
  return {
    records,
    status,
    source: 'live',
    fetchedAt,
    liveLookupFailed: false,
    error: null,
  };
}

export function cachedJobberRead<T>(records: T[], fetchedAtMs: number): JobberReadResult<T> {
  return {
    records,
    status: 'cached',
    source: 'cache',
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    liveLookupFailed: false,
    error: null,
  };
}

export function failedJobberRead<T>(err: unknown, fallback?: { records: T[]; fetchedAtMs: number } | null): JobberReadResult<T> {
  const error = classifyJobberReadError(err);
  if (fallback) {
    return {
      records: fallback.records,
      status: 'failed',
      source: 'cache',
      fetchedAt: new Date(fallback.fetchedAtMs).toISOString(),
      liveLookupFailed: true,
      error,
    };
  }
  return {
    records: [],
    status: 'failed',
    source: 'none',
    fetchedAt: null,
    liveLookupFailed: true,
    error,
  };
}

export function jobberReadMeta<T>(result: JobberReadResult<T>): JobberReadMeta {
  return {
    status: result.status,
    source: result.source,
    fetchedAt: result.fetchedAt,
    liveLookupFailed: result.liveLookupFailed,
    error: result.error,
  };
}

/**
 * Live health is true only after a successful live read in this response.
 * Webhook rows and a default flag do not count.
 */
export function jobberStatusPayload(probe: JobberReadMeta, webhookActive: boolean): {
  available: boolean;
  webhookActive: boolean;
  read: JobberReadMeta;
} {
  return {
    available: probe.status === 'live' && !probe.liveLookupFailed && probe.error == null,
    webhookActive,
    read: probe,
  };
}

export function finalizeRequestListRead(input: {
  live: JobberReadMeta;
  responseCount: number;
  webhookRowsUsed: boolean;
  webhookReadFailed: boolean;
}): { available: boolean; read: JobberReadMeta } {
  const read: JobberReadMeta = { ...input.live };

  if (input.webhookReadFailed && (read.status === 'empty' || input.responseCount === 0)) {
    return {
      available: false,
      read: {
        status: 'failed',
        source: read.source,
        fetchedAt: read.fetchedAt,
        liveLookupFailed: read.liveLookupFailed,
        error: read.error ?? {
          code: 'database',
          message: 'Saved Jobber requests could not be loaded.',
        },
      },
    };
  }

  if (input.webhookReadFailed && !read.error) {
    read.error = {
      code: 'database',
      message: 'Some saved Jobber requests could not be loaded.',
    };
  }

  if (read.liveLookupFailed) {
    if (input.responseCount > 0 && (read.source === 'none' || read.source === 'live')) {
      read.source = 'webhook';
    } else if (input.responseCount > 0 && read.source === 'cache' && input.webhookRowsUsed) {
      read.source = 'mixed';
    }
    return { available: false, read };
  }

  if (read.status === 'empty' && input.responseCount > 0) {
    read.source = 'webhook';
  } else if ((read.status === 'live' || read.status === 'cached') && input.webhookRowsUsed) {
    read.source = 'mixed';
  }

  const liveSucceeded = read.status === 'live' || read.status === 'empty';
  return {
    available: liveSucceeded && !read.liveLookupFailed,
    read,
  };
}
