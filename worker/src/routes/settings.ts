import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import type { User, AdvisorMode, ApprovalMode } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { ContentAdvisor } from '../services/content-advisor.js';
import { UserSettingsService } from '../services/user-settings-service.js';

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

/**
 * GET /content-advisor/suggest
 * Returns a content type suggestion based on the user's current advisor mode.
 */
app.get('/content-advisor/suggest', sessionMiddleware, async (c) => {
  const userId = c.get('user').id;
  const userSettingsService = new UserSettingsService(c.env.DB);
  const settings = await userSettingsService.getSettings(userId);
  const contentAdvisor = new ContentAdvisor(c.env.DB);
  const suggestion = await contentAdvisor.suggest(userId, settings.advisorMode);
  return c.json({ suggestion });
});

/**
 * GET /settings
 * Returns the authenticated user's settings.
 */
app.get('/settings', sessionMiddleware, async (c) => {
  const userId = c.get('user').id;
  const userSettingsService = new UserSettingsService(c.env.DB);
  const settings = await userSettingsService.getSettings(userId);
  return c.json({ settings });
});

/**
 * PUT /settings
 * Updates the authenticated user's advisor mode, approval mode, and/or
 * material price mode.
 */
app.put('/settings', sessionMiddleware, async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json() as {
    advisorMode?: AdvisorMode;
    approvalMode?: ApprovalMode;
    materialPriceMode?: boolean;
  };
  const userSettingsService = new UserSettingsService(c.env.DB);
  const settings = await userSettingsService.updateSettings(userId, {
    advisorMode: body.advisorMode,
    approvalMode: body.approvalMode,
    materialPriceMode: body.materialPriceMode,
  });
  return c.json({ settings });
});

export default app;