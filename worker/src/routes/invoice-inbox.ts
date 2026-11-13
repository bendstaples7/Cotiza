import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import type { User } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { EmailContextService } from '../services/email-context-service.js';

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

app.use('*', sessionMiddleware);

/** GET / - Ben's read-only invoice review list: rows + the mailbox the Gmail token reads. */
app.get('/', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM invoice_inbox_items ORDER BY created_at DESC LIMIT 200').all();
  const mailbox = await new EmailContextService(c.env.GMAIL_CLIENT_ID, c.env.GMAIL_CLIENT_SECRET, c.env.GMAIL_REFRESH_TOKEN).fetchMailboxAddress();
  return c.json({ mailbox, items: rows.results ?? [] });
});

export default app;
