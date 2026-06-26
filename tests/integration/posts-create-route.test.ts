import { describe, it, expect } from 'vitest';
import postRoutes from '../../worker/src/routes/posts.js';
import { createMockD1, configurePrepareResults } from '../unit/helpers/mock-d1.js';

const NOW = new Date().toISOString();

function sessionRow() {
  return {
    session_id: 'sess-1',
    last_active_at: NOW,
    id: 'user-1',
    email: 'ben@chicago-reno.com',
    name: 'Ben',
    created_at: NOW,
    user_last_active: NOW,
  };
}

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    user_id: 'user-1',
    channel_connection_id: null,
    content_type: 'education',
    caption: '',
    hashtags_json: '[]',
    status: 'draft',
    external_post_id: null,
    template_fields: null,
    created_at: NOW,
    updated_at: NOW,
    published_at: null,
    ...overrides,
  };
}

describe('POST /api/posts (create with no channel selected)', () => {
  it('creates a draft and binds NULL (never undefined) for an empty channel', async () => {
    const db = createMockD1();
    db.batch.mockResolvedValueOnce([]);
    // prepare() call order through middleware + handler:
    //   1) sessionMiddleware: SELECT session + user
    //   2) sessionMiddleware: UPDATE (touch session)
    //   3) create(): INSERT INTO posts (batched)
    //   4) create(): SELECT the new post
    configurePrepareResults(db, [
      { first: sessionRow() },
      { run: { success: true } },
      {},
      { first: postRow() },
    ]);

    const res = await postRoutes.request(
      '/',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          contentType: 'education',
          caption: '',
          hashtags: [],
          channelConnectionId: '',
        }),
      },
      { DB: db } as never,
    );

    expect(res.status).toBe(201);

    // The INSERT is the 3rd prepared statement; channel_connection_id is bind index 2.
    const insertStmt = db._stmts[2];
    const boundArgs = insertStmt.bind.mock.calls[0];
    expect(boundArgs[2]).toBeNull();
    expect(boundArgs[2]).not.toBeUndefined();
  });
});
