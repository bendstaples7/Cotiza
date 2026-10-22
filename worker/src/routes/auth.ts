import { newGoogleChallenge } from '../services/google-identity.js';
import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import { AuthService } from '../services/auth-service.js';

const app = new Hono<{ Bindings: Bindings }>();

function getBearerToken(c: { req: { header: (name: string) => string | undefined } }): string {
  const authHeader = c.req.header('Authorization');
  return authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

/**
 * POST /login
 * Validate email domain and create session.
 */
app.get('/google-challenge', async (c) => {
  if (!c.env.GOOGLE_SIGNIN_CLIENT_ID) return c.json({ error: 'Google sign-in is not configured.' }, 503);
  c.header('Cache-Control', 'no-store');
  return c.json({ clientId: c.env.GOOGLE_SIGNIN_CLIENT_ID, nonce: await newGoogleChallenge(c.env.DB) });
});

app.post('/login', async (c) => {
  try {
    const body = await c.req.json() as { credential?: string; nonce?: string };
    const result = await new AuthService(c.env.DB).initiateAuth(body?.credential ?? '', body?.nonce, c.env.GOOGLE_SIGNIN_CLIENT_ID);
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  } catch {
    return c.json({ error: 'Google sign-in failed. Use your Chicago Reno Google account and try again.' }, 401);
  }
});

/**
 * POST /verify
 * Check if the current session token is still valid.
 */
app.post('/verify', async (c) => {
  const token = getBearerToken(c);
  const authService = new AuthService(c.env.DB);
  const user = await authService.verifySession(token);

  if (!user) {
    return c.json({ valid: false }, 401);
  }

  return c.json({ valid: true, user });
});

/**
 * POST /logout
 * Destroy the current session.
 */
app.post('/logout', async (c) => {
  const token = getBearerToken(c);
  const authService = new AuthService(c.env.DB);
  await authService.logout(token);
  return c.json({ success: true });
});

export default app;
