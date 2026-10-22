import { verifyGoogleIdentity } from './google-identity.js';
import { PlatformError } from '../errors/index.js';
import type { User } from 'shared';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class AuthService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async initiateAuth(credential: string, nonce?: string, clientId?: string): Promise<{ user: User; token: string }> {
    const identity = await verifyGoogleIdentity(this.db, credential, nonce, clientId);
    const trimmedEmail = identity.email;
    if (!trimmedEmail || !trimmedEmail.endsWith('@chicago-reno.com')) {
      throw new PlatformError({
        severity: 'error',
        component: 'AuthModule',
        operation: 'initiateAuth',
        description: 'Only @chicago-reno.com email addresses can access this platform.',
        recommendedActions: ['Enter a valid @chicago-reno.com email address'],
      });
    }

    const normalizedEmail = trimmedEmail;
    const userName = normalizedEmail.split('@')[0];
    const userId = crypto.randomUUID();
    const settingsId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const token = crypto.randomUUID();

    // Upsert user
    await this.db.prepare(
      'INSERT INTO users (id, email, name) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET last_active_at = datetime(\'now\')'
    ).bind(userId, normalizedEmail, userName).run();

    // Fetch the user (may be existing or newly created)
    const row = await this.db.prepare(
      'SELECT id, email, name, created_at, last_active_at FROM users WHERE email = ?'
    ).bind(normalizedEmail).first() as any;

    const user: User = {
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: new Date(row.created_at),
      lastActiveAt: new Date(row.last_active_at),
    };

    // Ensure user_settings row exists
    await this.db.prepare(
      'INSERT INTO user_settings (id, user_id) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING'
    ).bind(settingsId, user.id).run();

    // Create session token (purge expired sessions for this user first)
    await this.db.prepare(
      'DELETE FROM sessions WHERE user_id = ? AND last_active_at < datetime(\'now\', \'-7 days\')'
    ).bind(user.id).run();

    await this.db.prepare(
      'INSERT INTO sessions (id, user_id, token, identity_verified) VALUES (?, ?, ?, 1)'
    ).bind(sessionId, user.id, token).run();

    return { user, token };
  }

  async verifySession(token: string): Promise<User | null> {
    if (!token) return null;

    const row = await this.db.prepare(
      'SELECT s.id AS session_id, s.last_active_at, u.id, u.email, u.name, u.created_at, u.last_active_at AS user_last_active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.identity_verified = 1'
    ).bind(token).first() as any;

    if (!row) return null;

    const lastActive = new Date(row.last_active_at);
    const elapsed = Date.now() - lastActive.getTime();

    if (elapsed > SESSION_TTL_MS) {
      await this.db.prepare('DELETE FROM sessions WHERE id = ?').bind(row.session_id).run();
      return null;
    }

    // Touch session
    await this.db.prepare(
      'UPDATE sessions SET last_active_at = datetime(\'now\') WHERE id = ?'
    ).bind(row.session_id).run();

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: new Date(row.created_at),
      lastActiveAt: new Date(row.user_last_active),
    };
  }

  async logout(token: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
}
