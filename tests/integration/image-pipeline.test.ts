import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleImageQueue } from '../../worker/src/queue/image-consumer.js';
import { installFetchMock, type FetchMock } from '../helpers/fetch-mock.js';
import { createMockD1, type MockD1Database } from '../unit/helpers/mock-d1.js';

function makeBatch() {
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    messages: [
      {
        body: { jobId: 'job-1', userId: 'user-1', request: { description: 'a kitchen', count: 1 } },
        ack,
        retry,
      },
    ],
  } as never;
  return { batch, ack, retry };
}

/** Pull the (status, error) bound to each image_generation_jobs UPDATE, in order. */
function jobStatusWrites(db: MockD1Database): Array<{ status: string; error?: string }> {
  const writes: Array<{ status: string; error?: string }> = [];
  db.prepare.mock.calls.forEach((call: [string], i: number) => {
    const sql = call[0];
    if (typeof sql === 'string' && sql.includes('image_generation_jobs') && sql.includes('SET status')) {
      const bound = db._stmts[i]?.bind.mock.calls[0];
      if (bound) writes.push({ status: bound[0] as string, error: bound[1] as string });
    }
  });
  return writes;
}

describe('image generation pipeline (handleImageQueue + OpenAI boundary)', () => {
  let fetchMock: FetchMock | null = null;
  afterEach(() => {
    fetchMock?.restore();
    fetchMock = null;
  });

  it('FAILS FAST (no retry) on a permanent OpenAI 403 org-not-verified error', async () => {
    fetchMock = installFetchMock().on('images/generations', {
      status: 403,
      text: '{"error":{"message":"Your organization must be verified to use gpt-image-1"}}',
    });
    const db = createMockD1();
    const { batch, ack, retry } = makeBatch();

    await handleImageQueue(batch, { DB: db, R2_BUCKET: {}, AI_TEXT_API_KEY: 'sk-test' } as never);

    const writes = jobStatusWrites(db);
    expect(writes.map((w) => w.status)).toEqual(['processing', 'failed']);
    expect(writes[1].error).toContain('403');
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('RETRIES on a transient OpenAI 500 error', async () => {
    fetchMock = installFetchMock().on('images/generations', { status: 500, text: 'internal error' });
    const db = createMockD1();
    const { batch, ack, retry } = makeBatch();

    await handleImageQueue(batch, { DB: db, R2_BUCKET: {}, AI_TEXT_API_KEY: 'sk-test' } as never);

    const writes = jobStatusWrites(db);
    expect(writes.map((w) => w.status)).toEqual(['processing', 'retrying']);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
  });

  it('FAILS FAST when the API key is missing (never calls OpenAI)', async () => {
    fetchMock = installFetchMock();
    const db = createMockD1();
    const { batch, ack, retry } = makeBatch();

    await handleImageQueue(batch, { DB: db, R2_BUCKET: {}, AI_TEXT_API_KEY: '' } as never);

    const writes = jobStatusWrites(db);
    expect(writes.map((w) => w.status)).toEqual(['processing', 'failed']);
    expect(writes[1].error?.toLowerCase()).toContain('not configured');
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(fetchMock.calls).toHaveLength(0);
  });
});
