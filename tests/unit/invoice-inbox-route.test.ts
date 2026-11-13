import { Hono } from 'hono';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../worker/src/services/auth-service.js', () => ({
  AuthService: class {
    async verifySession(token: string) {
      return token === 'office' ? { id: 'u', email: 'office@chicago-reno.com' } : null;
    }
  },
}));

vi.mock('../../worker/src/services/email-context-service.js', () => ({
  EmailContextService: class {
    async fetchMailboxAddress() {
      return 'office@chicago-reno.com';
    }
  },
}));

import routes from '../../worker/src/routes/invoice-inbox.js';

function app() {
  const a = new Hono();
  a.route('/api/invoice-inbox', routes);
  a.onError((e, c) =>
    c.json({ error: 'denied' }, (e as { statusCode?: number }).statusCode === 401 ? 401 : 500),
  );
  return a;
}

function env() {
  return {
    DB: {
      prepare: () => ({
        all: async () => ({ results: [{ status: 'would_log', vendor: '20four7VA' }] }),
      }),
    },
  };
}

const request = (token: string) =>
  new Request('http://local/api/invoice-inbox', {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });

describe('invoice inbox review route', () => {
  it('rejects a blank session', async () => {
    expect((await app().fetch(request(''), env() as never)).status).toBe(401);
  });

  it('returns the mailbox and items for an office session', async () => {
    const res = await app().fetch(request('office'), env() as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mailbox: 'office@chicago-reno.com',
      items: [{ status: 'would_log', vendor: '20four7VA' }],
    });
  });
});
