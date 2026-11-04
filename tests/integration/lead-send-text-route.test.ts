import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQ = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzU3NTY4NzI=';

const mocks = vi.hoisted(() => ({
  readRequest: vi.fn(),
  sendText: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../../worker/src/middleware/session.js', () => ({
  sessionMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { id: 'user-a', email: 'office@chicago-reno.com' });
    await next();
  },
}));
vi.mock('../../worker/src/services/jobber-integration.js', () => ({
  openJobberIntegration: vi.fn().mockResolvedValue({ jobberIntegration: {} }),
}));
vi.mock('../../worker/src/services/ops-assistant-read.js', () => ({
  OpsAssistantRead: vi.fn().mockImplementation(() => ({ readRequest: mocks.readRequest })),
}));
vi.mock('../../worker/src/services/phone-context-service.js', () => ({
  PhoneContextService: vi.fn().mockImplementation((key: string) => ({ isAvailable: () => key.length > 0, sendText: mocks.sendText })),
}));
vi.mock('../../worker/src/services/lead-contact-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../worker/src/services/lead-contact-service.js')>();
  return { ...actual, LeadContactService: vi.fn().mockImplementation(() => ({ log: mocks.log })) };
});

import leads from '../../worker/src/routes/leads.js';

const withPhone = { outcome: 'ok', request: { phone: { availability: 'present', value: '(773) 555-0100' } } };
const env = (quoKey = 'sk-quo') => ({ DB: {} as D1Database, QUO_API_KEY: quoKey }) as never;
const send = (body: unknown, quoKey?: string) =>
  leads.request(`/${REQ}/send-text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env(quoKey));

describe('POST /api/leads/:requestId/send-text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readRequest.mockResolvedValue(withPhone);
  });

  it('sends to the Jobber number and logs the text', async () => {
    mocks.sendText.mockResolvedValue({ status: 'sent', id: 'AC1' });
    mocks.log.mockResolvedValue({ id: 'lct_1' });
    // A recipient from the browser is ignored: the number always comes from Jobber.
    const res = await send({ text: 'Hi Emma', step: 'intro_text', to: '+15559999999' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, logged: true });
    expect(mocks.sendText).toHaveBeenCalledWith('(773) 555-0100', 'Hi Emma');
    expect(mocks.log).toHaveBeenCalledWith(REQ, expect.objectContaining({ channel: 'text', step: 'intro_text' }), 'user-a');
  });

  it('reports a sent text as sent even when logging fails', async () => {
    mocks.sendText.mockResolvedValue({ status: 'sent', id: 'AC1' });
    mocks.log.mockRejectedValue(new Error('D1 down'));
    const res = await send({ text: 'Hi Emma' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, logged: false, warning: expect.stringContaining('Do not send it again') });
  });

  it('refuses without sending when Quo, the number or the text is missing', async () => {
    expect((await send({ text: 'Hi' }, '')).status).toBe(409);
    mocks.readRequest.mockResolvedValue({ outcome: 'ok', request: { phone: { availability: 'missing' } } });
    expect((await send({ text: 'Hi' })).status).toBe(409);
    mocks.readRequest.mockResolvedValue({ outcome: 'failed', request: null });
    expect((await send({ text: 'Hi' })).status).toBe(502);
    mocks.readRequest.mockResolvedValue(withPhone);
    expect((await send({ text: '' })).status).toBe(400);
    expect((await send({ text: 'Hi', step: 'Bad Step!' })).status).toBe(400);
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('passes a failed send back as an error and logs nothing', async () => {
    mocks.sendText.mockResolvedValue({ status: 'failed', reason: 'Quo did not send the text (HTTP 400).' });
    const res = await send({ text: 'Hi' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Quo did not send the text (HTTP 400).' });
    expect(mocks.log).not.toHaveBeenCalled();
  });
});
