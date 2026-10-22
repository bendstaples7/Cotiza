import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { MockD1Database } from './helpers/mock-d1.js';
import { AuthService } from '../../worker/src/services/auth-service.js';
import { PlatformError } from '../../worker/src/errors/platform-error.js';

vi.mock('../../worker/src/services/google-identity.js', () => ({ verifyGoogleIdentity: vi.fn(async (_db, email) => ({ email: email.toLowerCase() })) }));

describe('AuthService', () => {
  let db: MockD1Database;
  let service: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    service = new AuthService(db as unknown as D1Database);
  });

  describe('initiateAuth()', () => {
    it('rejects empty email', async () => {
      await expect(service.initiateAuth('')).rejects.toThrow(PlatformError);
    });

    it('rejects non-chicago-reno.com email', async () => {
      await expect(service.initiateAuth('user@gmail.com')).rejects.toThrow(
        'Only @chicago-reno.com email addresses can access this platform.',
      );
    });

    it('rejects email with partial domain match', async () => {
      await expect(service.initiateAuth('user@not-chicago-reno.com')).rejects.toThrow(PlatformError);
    });

    it('accepts valid @chicago-reno.com email (case-insensitive)', async () => {
      // upsert user run, SELECT user first, upsert settings run, session insert run
      configurePrepareResults(db, [
        { run: { success: true } },
        {
          first: {
            id: 'user-uuid-1',
            email: 'alice@chicago-reno.com',
            name: 'alice',
            created_at: '2024-01-01T00:00:00Z',
            last_active_at: '2024-01-01T00:00:00Z',
          },
        },
        { run: { success: true } },
        { run: { success: true } },
      ]);

      const result = await service.initiateAuth('Alice@Chicago-Reno.COM');

      expect(result.user.email).toBe('alice@chicago-reno.com');
      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe('string');
    });

    it('creates user_settings row on first login', async () => {
      configurePrepareResults(db, [
        { run: { success: true } },
        {
          first: {
            id: 'user-1', email: 'bob@chicago-reno.com', name: 'bob',
            created_at: '2024-01-01T00:00:00Z', last_active_at: '2024-01-01T00:00:00Z',
          },
        },
        { run: { success: true } },
        { run: { success: true } },
      ]);

      await service.initiateAuth('bob@chicago-reno.com');

      // Third prepare call should be the user_settings INSERT
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_settings'),
      );
    });
  });

  describe('verifySession()', () => {
    it('returns null for empty token', async () => {
      const result = await service.verifySession('');
      expect(result).toBeNull();
    });

    it('returns null for non-existent token', async () => {
      configurePrepareResults(db, [{ first: null }]);
      const result = await service.verifySession('bad-token');
      expect(result).toBeNull();
    });

    it('returns null and deletes expired session', async () => {
      const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      configurePrepareResults(db, [
        {
          first: {
            session_id: 'sess-1', last_active_at: expired,
            id: 'user-1', email: 'a@chicago-reno.com', name: 'a',
            created_at: '2024-01-01T00:00:00Z', user_last_active: expired,
          },
        },
        { run: { success: true } },
      ]);

      const result = await service.verifySession('some-token');
      expect(result).toBeNull();
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM sessions'),
      );
    });

    it('returns user and touches session for valid token', async () => {
      const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      configurePrepareResults(db, [
        {
          first: {
            session_id: 'sess-2', last_active_at: recent,
            id: 'user-2', email: 'b@chicago-reno.com', name: 'b',
            created_at: '2024-01-01T00:00:00Z', user_last_active: recent,
          },
        },
        { run: { success: true } },
      ]);

      const result = await service.verifySession('valid-token');
      expect(result).not.toBeNull();
      expect(result!.email).toBe('b@chicago-reno.com');
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE sessions SET last_active_at'),
      );
    });
  });

  describe('logout()', () => {
    it('deletes the session by token', async () => {
      configurePrepareResults(db, [{ run: { success: true } }]);
      await service.logout('my-token');
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM sessions WHERE token'),
      );
    });
  });
});
