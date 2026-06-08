import { test as setup, expect } from '@playwright/test';
import path from 'node:path';

export const AUTH_FILE = path.join(__dirname, '../../.auth/state.json');

setup('authenticate', async ({ page }) => {
  await page.goto('/login');

  await page.getByLabel('Email').fill('office@chicago-reno.com');
  await page.getByRole('button', { name: 'Sign in' }).click();

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
