/**
 * Lead hub: everything known about one Jobber request on one page, plus the "info needed"
 * checklist the team works from. Session-authenticated (Cotiza users only).
 *
 * GET    /api/leads/summaries?ids=a,b     info-needed counts for queue cards
 * GET    /api/leads/:requestId            request, quotes, email and Quo context, checklist
 * GET    /api/leads/:requestId/photos/:i  one request photo (scaled down when large)
 * POST   /api/leads/:requestId/info       add a question
 * PATCH  /api/leads/info/:itemId          change status / answer / wording
 */
import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import { sessionMiddleware } from '../middleware/session.js';
import { openJobberIntegration } from '../services/jobber-integration.js';
import { OpsAssistantRead } from '../services/ops-assistant-read.js';
import { downloadRequestPhoto, loadRequestPhotos, photoFailureReason } from '../services/jobber-request-photos.js';
import { EmailContextService } from '../services/email-context-service.js';
import { PhoneContextService } from '../services/phone-context-service.js';
import { LeadInfoError, LeadInfoService, requireRequestId, summarize } from '../services/lead-info-service.js';
import { sanitizeLogText } from '../services/jobber-log-sanitize.mjs';

type Env = { Bindings: Bindings; Variables: { user: { id: string; email: string } } };
const app = new Hono<Env>();
app.use('*', sessionMiddleware);

function badRequest(err: unknown) {
  return err instanceof LeadInfoError ? { error: err.message } : null;
}

app.get('/summaries', async (c) => {
  const ids = (c.req.query('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return c.json({ summaries: await new LeadInfoService(c.env.DB).summaries(ids) });
});

app.get('/:requestId', async (c) => {
  let requestId: string;
  try { requestId = requireRequestId(c.req.param('requestId')); } catch (err) { return c.json(badRequest(err), 400); }
  const userId = c.get('user').id;
  const { jobberIntegration } = await openJobberIntegration(c.env.DB, c.env);
  const read = new OpsAssistantRead(jobberIntegration, c.env.DB, c.env.IMAGES);
  const info = new LeadInfoService(c.env.DB);

  const [request, quotes, items] = await Promise.all([
    read.readRequest(userId, { requestId }),
    read.listRequestQuotes(userId, { requestId }),
    info.list(requestId),
  ]);
  const detail = (request as { request?: { phone?: { value?: string }; email?: { value?: string } } | null }).request;
  const contact = { email: detail?.email?.value ?? null, phone: detail?.phone?.value ?? null };

  // Email and Quo context are best-effort: a missing connection is reported, never an empty history.
  const email = new EmailContextService(c.env.GMAIL_CLIENT_ID, c.env.GMAIL_CLIENT_SECRET, c.env.GMAIL_REFRESH_TOKEN);
  const phone = new PhoneContextService(c.env.QUO_API_KEY ?? '', c.env.QUO_PHONE_NUMBER_ID ?? null);
  const [emailText, phoneText] = await Promise.all([
    email.isAvailable() && contact?.email ? email.fetchContext(contact.email).catch(() => null) : Promise.resolve(null),
    phone.isAvailable() && contact?.phone ? phone.fetchContext(contact.phone).catch(() => null) : Promise.resolve(null),
  ]);

  return c.json({
    requestId,
    request,
    quotes,
    contact,
    email: !email.isAvailable()
      ? { status: 'not_connected' }
      : !contact?.email ? { status: 'no_address' }
        : emailText === null ? { status: 'failed' } : { status: 'ok', text: emailText },
    phone: !phone.isAvailable()
      ? { status: 'not_connected' }
      : !contact?.phone ? { status: 'no_number' }
        : phoneText === null ? { status: 'failed' } : { status: 'ok', text: phoneText },
    infoNeeded: { items, summary: summarize(items) },
  });
});

app.get('/:requestId/photos/:index', async (c) => {
  let requestId: string;
  try { requestId = requireRequestId(c.req.param('requestId')); } catch (err) { return c.json(badRequest(err), 400); }
  const index = Number(c.req.param('index'));
  if (!Number.isInteger(index) || index < 0 || index >= 20) return c.json({ error: 'index must be 0 to 19.' }, 400);
  const { jobberIntegration } = await openJobberIntegration(c.env.DB, c.env);
  try {
    const request = await loadRequestPhotos(jobberIntegration, requestId, null);
    const attachment = request?.noteAttachments?.edges?.[index]?.node;
    if (!attachment) return c.json({ error: 'No photo at that position.' }, 404);
    const image = await downloadRequestPhoto(attachment, c.env.IMAGES);
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Response(bytes, { headers: { 'Content-Type': image.mimeType, 'Cache-Control': 'private, max-age=600' } });
  } catch (err) {
    // Never echo fetch errors: they can contain the signed photo URL.
    console.warn('[leads] photo failed', sanitizeLogText(photoFailureReason(err)));
    return c.json({ error: 'The photo could not be loaded.', reason: photoFailureReason(err) }, 502);
  }
});

app.post('/:requestId/info', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { question?: unknown; required?: unknown };
  try {
    const item = await new LeadInfoService(c.env.DB).add(c.req.param('requestId'), body, { userId: c.get('user').id, via: 'app' });
    return c.json({ item }, 201);
  } catch (err) {
    const bad = badRequest(err);
    if (bad) return c.json(bad, 400);
    throw err;
  }
});

app.patch('/info/:itemId', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { status?: unknown; answer?: unknown; question?: unknown };
  try {
    const item = await new LeadInfoService(c.env.DB).update(c.req.param('itemId'), body, { userId: c.get('user').id, via: 'app' });
    return c.json({ item });
  } catch (err) {
    const bad = badRequest(err);
    if (bad) return c.json(bad, 400);
    throw err;
  }
});

export default app;
