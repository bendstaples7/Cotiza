/**
 * Lead hub: everything known about one Jobber request on one page, plus the "info needed"
 * checklist the team works from. Session-authenticated (Cotiza users only).
 *
 * GET    /api/leads/summaries?ids=a,b     info-needed counts for queue cards
 * GET    /api/leads/contact-status?ids=a,b  last and next contact for queue cards
 * GET    /api/leads/:requestId            request, quotes, email and Quo context, checklist
 * GET    /api/leads/:requestId/photos/:i  one request photo (scaled down when large)
 * POST   /api/leads/:requestId/info       add a question
 * PATCH  /api/leads/info/:itemId          change status / answer / wording
 * POST   /api/leads/:requestId/contacts   log a call, text, email or visit
 * PUT    /api/leads/:requestId/next-contact  set (date) or clear (null) the next contact date
 * POST   /api/leads/:requestId/send-text  send one confirmed text through Quo and log it
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
import { LeadContactError, LeadContactService, validateContact } from '../services/lead-contact-service.js';
import { gatherContactStatus, type RequestDetail } from '../services/lead-contact-status.js';

type Env = { Bindings: Bindings; Variables: { user: { id: string; email: string } } };
const app = new Hono<Env>();
app.use('*', sessionMiddleware);

function badRequest(err: unknown) {
  return err instanceof LeadInfoError || err instanceof LeadContactError ? { error: err.message } : null;
}

function contextServices(env: Bindings) {
  return {
    email: new EmailContextService(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, env.GMAIL_REFRESH_TOKEN),
    phone: new PhoneContextService(env.QUO_API_KEY ?? '', env.QUO_PHONE_NUMBER_ID ?? null),
  };
}

const MAX_STATUS_IDS = 50;
const STATUS_CONCURRENCY = 4;

app.get('/contact-status', async (c) => {
  const ids = [...new Set((c.req.query('ids') || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (ids.length > MAX_STATUS_IDS) return c.json({ error: `At most ${MAX_STATUS_IDS} leads at once.` }, 400);
  const valid = ids.filter((id) => { try { requireRequestId(id); return true; } catch { return false; } });
  const userId = c.get('user').id;
  const { jobberIntegration } = await openJobberIntegration(c.env.DB, c.env);
  const read = new OpsAssistantRead(jobberIntegration, c.env.DB, c.env.IMAGES);
  const contacts = new LeadContactService(c.env.DB);
  const now = Date.now();
  const statuses: Record<string, unknown> = {};
  let next = 0;
  const worker = async () => {
    while (next < valid.length) {
      const requestId = valid[next++];
      try {
        const request = await read.readRequest(userId, { requestId }) as unknown as { outcome?: string; request?: RequestDetail };
        // One set of services per lead: each tracks its own failed-read flag.
        const { email, phone } = contextServices(c.env);
        const { status } = await gatherContactStatus({ requestId, detail: request.request, requestFailed: request.outcome !== 'ok', contacts, phone, email, now });
        statuses[requestId] = status;
      } catch (err) {
        console.warn('[leads] contact status failed', sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180));
        statuses[requestId] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, valid.length) }, worker));
  return c.json({ statuses });
});

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
  // Separate service instances for the context text and the contact timeline: each tracks its own failed-read flag.
  const { email, phone } = contextServices(c.env);
  const timeline = contextServices(c.env);
  const failed = { status: 'failed' as const };
  const [emailResult, phoneResult, contactTimeline] = await Promise.all([
    email.isAvailable() && contact.email ? email.fetchContextResult(contact.email).catch(() => failed) : Promise.resolve(null),
    phone.isAvailable() && contact.phone ? phone.fetchContextResult(contact.phone).catch(() => failed) : Promise.resolve(null),
    gatherContactStatus({
      requestId,
      detail: detail as unknown as RequestDetail,
      requestFailed: (request as { outcome?: string }).outcome !== 'ok',
      contacts: new LeadContactService(c.env.DB),
      phone: timeline.phone,
      email: timeline.email,
      now: Date.now(),
    }),
  ]);

  return c.json({
    requestId,
    request,
    quotes,
    contact,
    email: !email.isAvailable() ? { status: 'not_connected' } : !contact.email ? { status: 'no_address' } : emailResult,
    phone: !phone.isAvailable() ? { status: 'not_connected' } : !contact.phone ? { status: 'no_number' } : phoneResult,
    infoNeeded: { items, summary: summarize(items) },
    contactStatus: contactTimeline.status,
    loggedContacts: contactTimeline.logged,
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

app.post('/:requestId/contacts', async (c) => {
  let requestId: string;
  try { requestId = requireRequestId(c.req.param('requestId')); } catch (err) { return c.json(badRequest(err), 400); }
  const body = await c.req.json().catch(() => null);
  try {
    const contact = await new LeadContactService(c.env.DB).log(requestId, body, c.get('user').id);
    return c.json({ contact }, 201);
  } catch (err) {
    const bad = badRequest(err);
    if (bad) return c.json(bad, 400);
    throw err;
  }
});

app.put('/:requestId/next-contact', async (c) => {
  let requestId: string;
  try { requestId = requireRequestId(c.req.param('requestId')); } catch (err) { return c.json(badRequest(err), 400); }
  const body = await c.req.json().catch(() => null) as { nextContactOn?: unknown } | null;
  if (!body || !('nextContactOn' in body)) return c.json({ error: 'Send nextContactOn (YYYY-MM-DD) or null.' }, 400);
  try {
    const nextContactOn = await new LeadContactService(c.env.DB).setNextContact(requestId, body.nextContactOn, c.get('user').id);
    return c.json({ nextContactOn });
  } catch (err) {
    const bad = badRequest(err);
    if (bad) return c.json(bad, 400);
    throw err;
  }
});

const MAX_TEXT = 1600;

app.post('/:requestId/send-text', async (c) => {
  let requestId: string;
  try { requestId = requireRequestId(c.req.param('requestId')); } catch (err) { return c.json(badRequest(err), 400); }
  const body = await c.req.json().catch(() => null) as { text?: unknown; step?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_TEXT) return c.json({ error: `text must be 1 to ${MAX_TEXT} characters.` }, 400);
  const { phone } = contextServices(c.env);
  if (!phone.isAvailable()) return c.json({ error: 'Quo is not connected to Cotiza.' }, 409);
  // The recipient always comes from Jobber, never from the browser.
  const { jobberIntegration } = await openJobberIntegration(c.env.DB, c.env);
  const read = new OpsAssistantRead(jobberIntegration, c.env.DB, c.env.IMAGES);
  const request = await read.readRequest(c.get('user').id, { requestId }) as unknown as { outcome?: string; request?: RequestDetail };
  const to = request.request?.phone?.availability === 'present' ? request.request.phone.value ?? null : null;
  if (request.outcome !== 'ok') return c.json({ error: 'The Jobber request could not be read, so nothing was sent.' }, 502);
  if (!to) return c.json({ error: 'This lead has no phone number in Jobber, so nothing was sent.' }, 409);
  const contacts = new LeadContactService(c.env.DB);
  // Check the log entry before sending, so a bad step doesn't leave a sent text unlogged.
  try { validateContact({ channel: 'text', step: body?.step ?? undefined }, Date.now()); } catch (err) { return c.json(badRequest(err), 400); }
  const sent = await phone.sendText(to, text);
  if (sent.status === 'failed') {
    console.warn('[leads] quo send failed', sanitizeLogText(sent.reason));
    return c.json({ error: sent.reason }, 502);
  }
  const contact = await contacts.log(requestId, { channel: 'text', note: 'Sent from Cotiza via Quo', step: body?.step ?? undefined }, c.get('user').id);
  return c.json({ sent: true, contact });
});

export default app;
