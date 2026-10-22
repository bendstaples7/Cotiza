import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const AUTH_FILE = path.join(__dirname, '../../.auth/state.json');

setup('authenticate', async ({ page }) => {
  // Seed only the local development database. No test auth route or verifier bypass ships in the worker.
  const base = new URL(process.env.BASE_URL ?? 'http://localhost:5173');
  if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Local auth fixture cannot run against remote hosts.');
  const token = randomUUID();
  const userId = randomUUID();
  const email = `e2e-${userId}@chicago-reno.com`;
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--command',
    `INSERT INTO users (id,email,name) VALUES ('${userId}','${email}','E2E'); INSERT INTO user_settings (id,user_id) VALUES ('${randomUUID()}','${userId}'); INSERT INTO sessions (id,user_id,token,identity_verified) VALUES ('${randomUUID()}','${userId}','${token}',1);`],
    { cwd: path.join(__dirname, '../../worker'), stdio: 'pipe' });
  // Google UI/network is mocked at the browser boundary. Real ID token validation has signed-token unit tests.
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'application/javascript', body: `
    window.google = {accounts:{id:{initialize(options){this.options=options;},renderButton(element){const button=document.createElement('button');button.textContent='Sign in with Google';button.onclick=()=>this.options.callback({credential:'e2e-browser-fixture'});element.appendChild(button);}}}};
  ` }));
  await page.route('**/api/auth/google-challenge', route => route.fulfill({ json: { clientId: 'e2e', nonce: 'e2e' } }));
  await page.route('**/api/auth/login', route => route.fulfill({ json: { token, user: { id: userId, email, name: 'E2E' } } }));
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();

  // Wait for redirect to the dashboard after login — exact path so we don't match /social/dashboard
  await page.waitForURL(/\/dashboard$/, { timeout: 15_000 });

  // After login the app runs a systems check before showing the main shell.
  // In CI (no real Jobber/Instagram tokens) this lands on an overlay screen
  // (e.g. "Connect Jobber") rather than the nav sidebar.  We just need to
  // confirm we're past the login page and the authenticated app rendered.
  await expect(
    page.locator('nav, [aria-label="Verifying connections"], h2:has-text("Connect Jobber"), h2:has-text("Connection Error")')
  ).toBeVisible({ timeout: 10_000 });

  // Persist auth state (localStorage + cookies) for subsequent tests
  await page.context().storageState({ path: AUTH_FILE });
});
