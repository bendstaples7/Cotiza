import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailContextService } from '../../worker/src/services/email-context-service.js';

function mockFetch(response: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(response),
  });
}

function mockFetchError() {
  return vi.fn().mockRejectedValue(new Error('Network error'));
}

describe('EmailContextService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const VALID_CREDENTIALS = {
    clientId: 'test-client-id.apps.googleusercontent.com',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
  };

  describe('isAvailable', () => {
    it('returns true when all credentials are set', () => {
      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      expect(service.isAvailable()).toBe(true);
    });

    it('returns false when client ID is empty', () => {
      const service = new EmailContextService('', VALID_CREDENTIALS.clientSecret, VALID_CREDENTIALS.refreshToken);
      expect(service.isAvailable()).toBe(false);
    });

    it('returns false when client secret is empty', () => {
      const service = new EmailContextService(VALID_CREDENTIALS.clientId, '', VALID_CREDENTIALS.refreshToken);
      expect(service.isAvailable()).toBe(false);
    });

    it('returns false when refresh token is empty', () => {
      const service = new EmailContextService(VALID_CREDENTIALS.clientId, VALID_CREDENTIALS.clientSecret, '');
      expect(service.isAvailable()).toBe(false);
    });

    it('returns false when all credentials are empty', () => {
      const service = new EmailContextService('', '', '');
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('fetchContext', () => {
    it('returns empty string when credentials are not available', async () => {
      const service = new EmailContextService('', '', '');
      const result = await service.fetchContext('customer@example.com');
      expect(result).toBe('');
    });

    it('returns empty string when customerEmail is empty', async () => {
      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      const result = await service.fetchContext('');
      expect(result).toBe('');
    });

    it('returns empty string when customerEmail is invalid format', async () => {
      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      const result = await service.fetchContext('not-an-email');
      expect(result).toBe('');
    });

    it('returns empty string when OAuth token refresh fails', async () => {
      const fetchMock = mockFetchError();
      vi.stubGlobal('fetch', fetchMock);

      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      const result = await service.fetchContext('customer@example.com');

      expect(result).toBe('');
    });

    it('returns empty string when no messages found', async () => {
      // Token refresh response
      const tokenResponse = {
        access_token: 'test-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      };
      // Gmail list response with no messages
      const listResponse = {
        messages: undefined,
        resultSizeEstimate: 0,
      };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(tokenResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(listResponse) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      const result = await service.fetchContext('customer@example.com');

      expect(result).toBe('');
      // Token refresh + messages list query
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns formatted context with email messages', async () => {
      const tokenResponse = {
        access_token: 'test-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      };
      const listResponse = {
        messages: [{ id: 'msg1', threadId: 'thread1' }, { id: 'msg2', threadId: 'thread2' }],
        resultSizeEstimate: 2,
      };
      const msg1Detail = {
        id: 'msg1',
        threadId: 'thread1',
        labelIds: ['INBOX'],
        snippet: 'Hi, I need a quote for kitchen renovation',
        payload: {
          headers: [
            { name: 'From', value: 'customer@example.com' },
            { name: 'To', value: 'business@example.com' },
            { name: 'Subject', value: 'Kitchen Renovation Quote' },
            { name: 'Date', value: 'Mon, 15 Jun 2026 10:30:00 -0500' },
          ],
        },
        internalDate: '1781605800000',
      };
      const msg2Detail = {
        id: 'msg2',
        threadId: 'thread2',
        labelIds: ['SENT'],
        snippet: 'Thanks for reaching out! Could you send some photos?',
        payload: {
          headers: [
            { name: 'From', value: 'business@example.com' },
            { name: 'To', value: 'customer@example.com' },
            { name: 'Subject', value: 'Re: Kitchen Renovation Quote' },
            { name: 'Date', value: 'Mon, 15 Jun 2026 11:00:00 -0500' },
          ],
        },
        internalDate: '1781607600000',
      };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(tokenResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(listResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(msg1Detail) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(msg2Detail) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      const result = await service.fetchContext('customer@example.com');

      expect(result).toContain('Email Conversation Context');
      expect(result).toContain('Kitchen Renovation Quote');
      expect(result).toContain('customer@example.com');
      expect(result).toContain('business@example.com');
      expect(result).toContain('kitchen renovation');
      expect(result).toContain('Thanks for reaching out');
      expect(result).toContain('End Email Context');
    });

    it('gracefully handles network failures', async () => {
      vi.stubGlobal('fetch', mockFetchError());

      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      const result = await service.fetchContext('customer@example.com');

      expect(result).toBe('');
    });

    it('gracefully handles partial failures (token works but message fetch fails)', async () => {
      const tokenResponse = {
        access_token: 'test-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(tokenResponse) })
        .mockRejectedValueOnce(new Error('Gmail API timeout'));
      vi.stubGlobal('fetch', fetchMock);

      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      const result = await service.fetchContext('customer@example.com');

      expect(result).toBe('');
    });

    it('labels customer-sent messages as Incoming', async () => {
      const tokenResponse = {
        access_token: 'test-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      };
      const listResponse = {
        messages: [{ id: 'msg1', threadId: 'thread1' }],
        resultSizeEstimate: 1,
      };
      const msgDetail = {
        id: 'msg1',
        threadId: 'thread1',
        labelIds: ['INBOX'],
        snippet: 'Need a quote please',
        payload: {
          headers: [
            { name: 'From', value: 'Customer Name <customer@example.com>' },
            { name: 'To', value: 'business@example.com' },
            { name: 'Subject', value: 'Quote request' },
            { name: 'Date', value: 'Mon, 15 Jun 2026 10:30:00 -0500' },
          ],
        },
        internalDate: '1781605800000',
      };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(tokenResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(listResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(msgDetail) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      const result = await service.fetchContext('customer@example.com');

      expect(result).toContain('--- Incoming Email ---');
    });

    it('labels business-sent messages as Outgoing', async () => {
      const tokenResponse = {
        access_token: 'test-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      };
      const listResponse = {
        messages: [{ id: 'msg2', threadId: 'thread2' }],
        resultSizeEstimate: 1,
      };
      const msgDetail = {
        id: 'msg2',
        threadId: 'thread2',
        labelIds: ['SENT'],
        snippet: 'Thanks for reaching out',
        payload: {
          headers: [
            { name: 'From', value: 'business@example.com' },
            { name: 'To', value: 'customer@example.com' },
            { name: 'Subject', value: 'Re: Quote request' },
            { name: 'Date', value: 'Mon, 15 Jun 2026 11:00:00 -0500' },
          ],
        },
        internalDate: '1781607600000',
      };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(tokenResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(listResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(msgDetail) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );
      const result = await service.fetchContext('customer@example.com');

      expect(result).toContain('--- Outgoing Email ---');
    });

    it('caches OAuth token for subsequent calls within expiry', async () => {
      const tokenResponse = {
        access_token: 'test-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      };

      const listResponse = { messages: undefined, resultSizeEstimate: 0 };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(tokenResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(listResponse) })
        // Second call should NOT refresh token if cached
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(listResponse) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new EmailContextService(
        VALID_CREDENTIALS.clientId,
        VALID_CREDENTIALS.clientSecret,
        VALID_CREDENTIALS.refreshToken,
      );

      // First call
      await service.fetchContext('customer@example.com');
      // Second call — should reuse cached token
      await service.fetchContext('other@example.com');

      // Token refresh called only once (not per call)
      const oauthCalls = fetchMock.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && (call[0] as string).includes('oauth2'),
      );
      expect(oauthCalls.length).toBe(1);
    });
  });
});