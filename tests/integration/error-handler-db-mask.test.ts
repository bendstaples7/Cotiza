import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../../worker/src/middleware/error-handler.js';
import { PlatformError } from '../../worker/src/errors/platform-error.js';
import { createMockD1 } from '../unit/helpers/mock-d1.js';

function appThatThrows(error: unknown) {
  const app = new Hono();
  app.get('/boom', () => {
    throw error;
  });
  app.onError(errorHandler as never);
  return app;
}

const env = () => ({ DB: createMockD1() }) as never;

describe('errorHandler (database error masking)', () => {
  it('masks a raw D1_TYPE_ERROR with a friendly message', async () => {
    const app = appThatThrows(
      new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'"),
    );

    const res = await app.request('/boom', {}, env());
    const body = (await res.json()) as { message: string; operation: string };

    expect(res.status).toBe(500);
    expect(body.message).toBe('Something went wrong while loading data. Please try again.');
    expect(body.message).not.toContain('D1_');
    expect(body.message).not.toContain('undefined');
    expect(body.operation).toBe('database');
  });

  it('masks SQLITE_ constraint errors too', async () => {
    const app = appThatThrows(new Error('SQLITE_CONSTRAINT: FOREIGN KEY constraint failed'));

    const res = await app.request('/boom', {}, env());
    const body = (await res.json()) as { message: string };

    expect(res.status).toBe(500);
    expect(body.message).toBe('Something went wrong while loading data. Please try again.');
    expect(body.message).not.toContain('SQLITE_');
  });

  it('passes through non-database error messages unchanged', async () => {
    const app = appThatThrows(new Error('Something specific and safe'));

    const res = await app.request('/boom', {}, env());
    const body = (await res.json()) as { message: string };

    expect(body.message).toBe('Something specific and safe');
  });

  it('leaves a PlatformError (and its status code) untouched', async () => {
    const app = appThatThrows(
      new PlatformError({
        severity: 'warning',
        component: 'X',
        operation: 'y',
        description: 'Custom user message',
        recommendedActions: ['do x'],
        statusCode: 404,
      }),
    );

    const res = await app.request('/boom', {}, env());
    const body = (await res.json()) as { message: string };

    expect(res.status).toBe(404);
    expect(body.message).toBe('Custom user message');
  });
});
