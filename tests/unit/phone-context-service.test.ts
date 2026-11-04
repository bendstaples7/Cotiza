import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhoneContextService, toE164 } from '../../worker/src/services/phone-context-service.js';

function mockFetch(response: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(response),
  });
}

function mockFetchError() {
  return vi.fn().mockRejectedValue(new Error('Network error'));
}

describe('PhoneContextService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('isAvailable', () => {
    it('returns true when API key is set', () => {
      const service = new PhoneContextService('sk-test-key');
      expect(service.isAvailable()).toBe(true);
    });

    it('returns false when API key is empty', () => {
      const service = new PhoneContextService('');
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('fetchContext', () => {
    it('returns empty string when API key is not available', async () => {
      const service = new PhoneContextService('');
      const result = await service.fetchContext('+15551234567');
      expect(result).toBe('');
    });

    it('returns empty string when no conversations, messages, or calls found', async () => {
      const fetchMock = mockFetch({
        data: [],
        totalItems: 0,
        nextPageToken: null,
      });
      vi.stubGlobal('fetch', fetchMock);

      const service = new PhoneContextService('sk-test-key', 'PN123');
      const result = await service.fetchContext('+15551234567');

      expect(result).toBe('');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('returns formatted context with text messages', async () => {
      const conversationsResponse = {
        data: [{ id: 'conv1', name: 'Test Customer', participants: ['+15551234567'], lastActivityAt: '2026-06-15T12:00:00Z', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-15T12:00:00Z', phoneNumberId: 'PN123' }],
        totalItems: 1,
        nextPageToken: null,
      };
      const messagesResponse = {
        data: [
          { id: 'msg1', to: ['+15551234567'], from: '+17773456789', text: 'Hi, I need a quote for drywall repair', direction: 'incoming', status: 'delivered', createdAt: '2026-06-14T10:30:00Z', userId: null },
          { id: 'msg2', to: ['+15551234567'], from: '+17773456789', text: 'Sure, can you send photos of the damage?', direction: 'outgoing', status: 'delivered', createdAt: '2026-06-14T10:35:00Z', userId: 'user1' },
        ],
        totalItems: 2,
        nextPageToken: null,
      };
      const callsResponse = {
        data: [],
        totalItems: 0,
        nextPageToken: null,
      };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(conversationsResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(messagesResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(callsResponse) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new PhoneContextService('sk-test-key', 'PN123');
      const result = await service.fetchContext('+15551234567');

      expect(result).toContain('Phone Conversation Context');
      expect(result).toContain('[Text Messages]');
      expect(result).toContain('[Customer]');
      expect(result).toContain('[Business]');
      expect(result).toContain('drywall repair');
      expect(result).toContain('End Phone Context');
      expect(result).not.toContain('[Call History]');
      expect(result).not.toContain('[Conversation Threads Found]');
    });

    it('returns formatted context with call history', async () => {
      const conversationsResponse = { data: [], totalItems: 0, nextPageToken: null };
      const messagesResponse = { data: [], totalItems: 0, nextPageToken: null };
      const callsResponse = {
        data: [
          { id: 'call1', direction: 'incoming', status: 'completed', duration: 300, participants: ['+15551234567', '+17773456789'], answeredAt: '2026-06-14T09:00:00Z', completedAt: '2026-06-14T09:05:00Z', createdAt: '2026-06-14T09:00:00Z', aiHandled: null },
        ],
        totalItems: 1,
        nextPageToken: null,
      };
      const transcriptResponse = { data: { callId: 'call1', status: 'unavailable', dialogue: null, duration: 0 } };
      const summaryResponse = { data: { callId: 'call1', status: 'completed', summary: ['Customer wants drywall repair in basement'], nextSteps: ['Send photos of current damage'] } };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(conversationsResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(messagesResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(callsResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(transcriptResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(summaryResponse) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new PhoneContextService('sk-test-key', 'PN123');
      const result = await service.fetchContext('+15551234567');

      expect(result).toContain('Phone Conversation Context');
      expect(result).toContain('[Call History]');
      expect(result).toContain('Incoming call');
      expect(result).toContain('Summary');
      expect(result).toContain('drywall repair in basement');
      expect(result).toContain('Send photos');
    });

    it('gracefully handles network failures', async () => {
      vi.stubGlobal('fetch', mockFetchError());

      const service = new PhoneContextService('sk-test-key', 'PN123');
      const result = await service.fetchContext('+15551234567');

      expect(result).toBe('');
    });

    it('gracefully handles partial failures (one endpoint fails)', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [], totalItems: 0, nextPageToken: null }) })
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [], totalItems: 0, nextPageToken: null }) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new PhoneContextService('sk-test-key', 'PN123');
      const result = await service.fetchContext('+15551234567');

      expect(result).toBe('');
    });

    it('normalizes phone numbers without + prefix', async () => {
      const fetchMock = mockFetch({
        data: [],
        totalItems: 0,
        nextPageToken: null,
      });
      vi.stubGlobal('fetch', fetchMock);

      const service = new PhoneContextService('sk-test-key', 'PN123');
      await service.fetchContext('15551234567');

      const firstCallUrl = fetchMock.mock.calls[0][0] as string;
      expect(firstCallUrl).toContain('phoneNumbers');
      expect(firstCallUrl).toContain('%2B15551234567');
    });

    it('returns conversations-only fallback when messages and calls are unavailable', async () => {
      const conversationsResponse = {
        data: [
          { id: 'conv1', name: 'Test Customer', participants: ['+15551234567'], lastActivityAt: '2026-06-15T12:00:00Z', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-15T12:00:00Z', phoneNumberId: 'PN123' },
        ],
        totalItems: 1,
        nextPageToken: null,
      };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(conversationsResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [], totalItems: 0, nextPageToken: null }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [], totalItems: 0, nextPageToken: null }) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new PhoneContextService('sk-test-key');
      const result = await service.fetchContext('+15551234567');

      expect(result).toContain('[Conversation Threads Found: 1]');
      expect(result).toContain('Test Customer');
    });
  });

  describe('without QUO_PHONE_NUMBER_ID', () => {
    const empty = { data: [], totalItems: 0, nextPageToken: null };
    const route = (handlers: Record<string, unknown>) => vi.fn().mockImplementation(async (url: string) => {
      const path = new URL(url).pathname.replace('/v1', '');
      const params = new URL(url).searchParams;
      const key = `${path}${params.get('phoneNumberId') ? `@${params.get('phoneNumberId')}` : ''}`;
      if (!(key in handlers)) return { ok: true, json: () => Promise.resolve(empty) };
      const value = handlers[key];
      return value === 'fail' ? { ok: false, json: () => Promise.resolve({}) } : { ok: true, json: () => Promise.resolve(value) };
    });

    it('looks up the workspace numbers once and searches all of them', async () => {
      const fetchMock = route({
        '/phone-numbers': { data: [{ id: 'PN1' }, { id: 'PN2' }] },
        '/messages@PN1': { data: [{ id: 'm1', to: [], from: '+1', text: 'Older text', direction: 'outgoing', status: 'delivered', createdAt: '2026-11-01T10:00:00Z', userId: 'u' }] },
        '/messages@PN2': { data: [{ id: 'm2', to: [], from: '+1', text: 'Newer text', direction: 'incoming', status: 'delivered', createdAt: '2026-11-02T10:00:00Z', userId: null }] },
      });
      vi.stubGlobal('fetch', fetchMock);
      const service = new PhoneContextService('sk-test-key');
      const result = await service.fetchContextResult('(555) 123-4567');
      expect(result.status).toBe('ok');
      const text = (result as { text: string }).text;
      expect(text.indexOf('Older text')).toBeLessThan(text.indexOf('Newer text'));
      const paths = fetchMock.mock.calls.map(([u]) => new URL(u as string).pathname);
      expect(paths.filter((p) => p === '/v1/phone-numbers')).toHaveLength(1);
      expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('%2B15551234567'))).toBe(true);
    });

    it('reports a failed number lookup as a failed read, not an empty history', async () => {
      const fetchMock = route({ '/phone-numbers': 'fail' });
      vi.stubGlobal('fetch', fetchMock);
      const service = new PhoneContextService('sk-test-key');
      expect(await service.fetchContextResult('+15551234567')).toEqual({ status: 'failed' });
      // A failed lookup is not cached: the next read asks Quo again.
      expect(await service.fetchContextResult('+15551234567')).toEqual({ status: 'failed' });
      const lookups = fetchMock.mock.calls.filter(([u]) => new URL(u as string).pathname === '/v1/phone-numbers');
      expect(lookups).toHaveLength(2);
    });
  });

  describe('toE164', () => {
    it('turns Jobber-style US numbers into +1 numbers', () => {
      expect(toE164('(773) 555-0100')).toBe('+17735550100');
      expect(toE164('1-773-555-0100')).toBe('+17735550100');
      expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
      expect(toE164('(773) 555-0100 x123')).toBe('+17735550100');
      expect(toE164('773-555-0100 ext. 4')).toBe('+17735550100');
      expect(toE164('n/a')).toBeNull();
    });
  });

  describe('sendText', () => {
    it('sends from the discovered number to the normalised customer number', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [{ id: 'PN1' }] }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: { id: 'AC1' } }) });
      vi.stubGlobal('fetch', fetchMock);
      const result = await new PhoneContextService('sk-test-key').sendText('(773) 555-0100', 'Hi there');
      expect(result).toEqual({ status: 'sent', id: 'AC1' });
      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('https://api.openphone.com/v1/messages');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ content: 'Hi there', from: 'PN1', to: ['+17735550100'] });
      expect((init.headers as Record<string, string>).Authorization).toBe('sk-test-key');
    });

    it('reports a failed send and refuses without a key or number', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({}) }));
      expect(await new PhoneContextService('sk-test-key', 'PN1').sendText('+17735550100', 'Hi')).toEqual({ status: 'failed', reason: 'Quo did not send the text (HTTP 400).' });
      expect((await new PhoneContextService('').sendText('+17735550100', 'Hi')).status).toBe('failed');
      expect((await new PhoneContextService('sk-test-key', 'PN1').sendText('n/a', 'Hi')).status).toBe('failed');
    });
  });
});
