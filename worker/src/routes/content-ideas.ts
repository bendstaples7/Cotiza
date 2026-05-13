import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import { ContentType } from 'shared';
import type { User } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { ContentIdeasService } from '../services/content-ideas-service.js';
import { PlatformError } from '../errors/index.js';

const VALID_CONTENT_TYPES = Object.values(ContentType);

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

app.use('*', sessionMiddleware);

/**
 * GET /
 * Get unused ideas by content type.
 */
app.get('/', async (c) => {
  const rawContentType = (c.req.query('contentType') || '').trim();
  if (!rawContentType || !(VALID_CONTENT_TYPES as string[]).includes(rawContentType)) {
    throw new PlatformError({
      severity: 'warning',
      component: 'ContentIdeas',
      operation: 'list',
      description: 'A valid contentType query parameter is required. Valid types: ' + VALID_CONTENT_TYPES.join(', '),
      recommendedActions: ['Provide a valid contentType'],
    });
  }
  const service = new ContentIdeasService(c.env.DB, c.env.AI_TEXT_API_KEY, c.env.AI_TEXT_API_URL);
  const ideas = await service.getUnused(c.get('user').id, rawContentType as ContentType);
  return c.json({ ideas });
});

/**
 * POST /generate
 * Generate a new batch of ideas.
 */
app.post('/generate', async (c) => {
  let body: { contentType?: string };
  try {
    body = await c.req.json() as { contentType?: string };
  } catch {
    throw new PlatformError({
      severity: 'warning',
      component: 'ContentIdeas',
      operation: 'generate',
      description: 'Invalid JSON in request body.',
      recommendedActions: ['Send a valid JSON body with a contentType field'],
    });
  }
  const rawContentType = (typeof body.contentType === 'string' ? body.contentType : '').trim();
  if (!rawContentType || !(VALID_CONTENT_TYPES as string[]).includes(rawContentType)) {
    throw new PlatformError({
      severity: 'warning',
      component: 'ContentIdeas',
      operation: 'generate',
      description: 'A valid contentType is required. Valid types: ' + VALID_CONTENT_TYPES.join(', '),
      recommendedActions: ['Provide a valid contentType'],
    });
  }
  const service = new ContentIdeasService(c.env.DB, c.env.AI_TEXT_API_KEY, c.env.AI_TEXT_API_URL);
  const ideas = await service.generateBatch(c.get('user').id, rawContentType as ContentType);
  return c.json({ ideas });
});

/**
 * POST /:id/use
 * Mark an idea as used.
 */
app.post('/:id/use', async (c) => {
  const service = new ContentIdeasService(c.env.DB, c.env.AI_TEXT_API_KEY, c.env.AI_TEXT_API_URL);
  const idea = await service.markUsed(c.req.param('id'), c.get('user').id);
  if (!idea) {
    throw new PlatformError({
      severity: 'warning',
      component: 'ContentIdeas',
      operation: 'markUsed',
      description: 'Idea not found.',
      recommendedActions: ['Check the idea ID'],
    });
  }
  return c.json({ idea });
});

/**
 * DELETE /:id
 * Dismiss/delete an idea.
 */
app.delete('/:id', async (c) => {
  const service = new ContentIdeasService(c.env.DB, c.env.AI_TEXT_API_KEY, c.env.AI_TEXT_API_URL);
  const deleted = await service.deleteIdea(c.req.param('id'), c.get('user').id);
  if (!deleted) {
    throw new PlatformError({
      severity: 'warning',
      component: 'ContentIdeas',
      operation: 'delete',
      description: 'Idea not found.',
      recommendedActions: ['Check the idea ID'],
    });
  }
  return c.json({ success: true });
});

export default app;
