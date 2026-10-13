import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOpsAssistantApp } from '../../worker/src/routes/ops-assistant.js';
import { createMockD1, configurePrepareResults } from '../unit/helpers/mock-d1.js';
import type { MockD1Database } from '../unit/helpers/mock-d1.js';

vi.mock('../../worker/src/services/auth-service.js', () => ({
  AuthService: vi.fn().mockImplementation(() => ({
    verifySession: vi.fn().mockResolvedValue({
      id: 'user-a',
      email: 'test@chicago-reno.com',
      name: 'Test User',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      lastActiveAt: new Date('2025-01-01T00:00:00Z'),
    }),
  })),
}));

describe('assistant token admin routes', () => {
  let db: MockD1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
  });

  const AUTH = { Authorization: 'Bearer cotiza-session', 'Content-Type': 'application/json' };
  const env = () => ({ DB: db as unknown as D1Database }) as never;

  it('mints, lists, and revokes tokens for the signed-in user', async () => {
    configurePrepareResults(db, [
      { run: { success: true, meta: { changes: 1 } } },
      {
        all: {
          results: [{
            id: 'tok-1',
            label: 'local exercise',
            kind: 'access',
            expires_at: '2099-01-01T00:00:00.000Z',
            revoked_at: null,
            created_at: '2026-03-01T00:00:00.000Z',
          }],
        },
      },
      { run: { success: true, meta: { changes: 1 } } },
    ]);

    const app = createOpsAssistantApp();
    const minted = await app.request('http://127.0.0.1:8787/api/assistant/tokens', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ label: 'local exercise' }),
    }, env());
    expect(minted.status).toBe(201);
    const issued = await minted.json() as { id: string; token: string; scope: string };
    expect(issued.token).toMatch(/^ctz_/);
    expect(issued.scope).toBe('ops:read');

    const listed = await app.request('http://127.0.0.1:8787/api/assistant/tokens', {
      headers: { Authorization: 'Bearer cotiza-session' },
    }, env());
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { tokens: Array<{ id: string; label: string }> };
    expect(listBody.tokens[0].label).toBe('local exercise');

    const revoked = await app.request('http://127.0.0.1:8787/api/assistant/tokens/tok-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer cotiza-session' },
    }, env());
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(String(db.prepare.mock.calls[2][0])).toContain('user_id');
  });

  it('returns 404 when revoking another user token', async () => {
    configurePrepareResults(db, [{ run: { success: true, meta: { changes: 0 } } }]);
    const app = createOpsAssistantApp();
    const response = await app.request('http://127.0.0.1:8787/api/assistant/tokens/owned-by-another-user', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer cotiza-session' },
    }, env());
    expect(response.status).toBe(404);
    expect(String(db.prepare.mock.calls[0][0])).toContain('user_id');
    expect(db._stmts[0].bind).toHaveBeenCalledWith('owned-by-another-user', 'user-a');
  });
});
