import type { ErrorHandler } from 'hono';
import { PlatformError } from '../errors/platform-error.js';
import { formatErrorResponse } from '../errors/format-error.js';
import { safeBind } from '../db/safe-bind.js';
import type { Bindings } from '../bindings.js';

/**
 * Matches database/driver internals (D1, SQLite, raw bind type errors) that
 * must never be surfaced to end users verbatim.
 */
const DB_ERROR_PATTERN = /D1_[A-Z_]+|SQLITE_[A-Z_]+|not supported for value/;

export const errorHandler: ErrorHandler<{ Bindings: Bindings }> = async (err, c) => {
  let platformError: PlatformError;
  // Detail recorded server-side; for masked errors this differs from the
  // (sanitized) message returned to the client.
  let logDescription: string;

  if (err instanceof PlatformError) {
    platformError = err;
    logDescription = err.description;
  } else {
    const rawMessage =
      (err instanceof Error ? err.message : String(err)) || 'An unexpected error occurred.';

    if (DB_ERROR_PATTERN.test(rawMessage)) {
      // Never leak raw DB/driver internals to the client.
      console.error('[errorHandler] Masked database error from client:', rawMessage);
      logDescription = 'Database error: ' + rawMessage;
      platformError = new PlatformError({
        severity: 'error',
        component: 'Server',
        operation: 'database',
        description: 'Something went wrong while loading data. Please try again.',
        recommendedActions: ['Try again', 'Contact support if the problem persists'],
      });
    } else {
      logDescription = rawMessage;
      platformError = new PlatformError({
        severity: 'error',
        component: 'Server',
        operation: 'unknown',
        description: rawMessage,
        recommendedActions: ['Try again', 'Contact support if the problem persists'],
      });
    }
  }

  const statusCode = platformError.statusCode ?? (platformError.severity === 'warning' ? 400 : 500);

  // Best-effort log to activity_log_entries (records the raw detail, not the
  // sanitized client-facing message).
  try {
    const db = c.env.DB;
    if (db) {
      const id = crypto.randomUUID();
      // Try to get user from context for user_id
      let userId = 'system';
      try {
        const user = c.get('user' as never) as { id: string } | undefined;
        if (user && user.id) {
          userId = user.id;
        }
      } catch (_) {
        // no user in context
      }
      await safeBind(
        db.prepare(
          'INSERT INTO activity_log_entries (id, user_id, component, operation, severity, description) VALUES (?, ?, ?, ?, ?, ?)'
        ),
        id, userId, platformError.component, platformError.operation, platformError.severity, logDescription
      ).run();
    }
  } catch (_) {
    // do not throw if logging fails
  }

  return c.json(formatErrorResponse(platformError), statusCode as any);
};
