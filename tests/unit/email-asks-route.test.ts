import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';

import routes from '../../worker/src/routes/email-asks.js';

type Status = 'needs_you' | 'drafted' | 'done' | 'dismissed';

interface EmailAsk {
  message_id: string;
  status: Status;
  received_at: string;
  created_at: string;
}

function makeStore(rows: EmailAsk[]) {
  return {
    prepare(sql: string) {
      return {
        async all() {
          const open = rows
            .filter((r) => r.status === 'needs_you' || r.status === 'drafted')
            .sort(
              (a, b) =>
                b.received_at.localeCompare(a.received_at) ||
                b.created_at.localeCompare(a.created_at),
            );
          return { results: open };
        },
        bind(...args: unknown[]) {
          return {
            async run() {
              const [status, messageId] = args as [string, string];
              let changes = 0;
              for (const row of rows) {
                if (row.message_id === messageId) {
                  row.status = status as Status;
                  changes = 1;
                }
              }
              return { meta: { changes } };
            },
          };
        },
      };
    },
    rows,
  };
}

function app() {
  const a = new Hono();
  a.route('/api/email-asks', routes);
  return a;
}

function env(key: string, rows: EmailAsk[] = []) {
  return { EMAIL_ASKS_KEY: key, DB: makeStore(rows) };
}

const get = (key: string) =>
  new Request('http://local/api/email-asks', {
    headers: key ? { Authorization: 'Bearer ' + key } : {},
  });

const post = (key: string, messageId: string, body: unknown) =>
  new Request(`http://local/api/email-asks/${messageId}/status`, {
    method: 'POST',
    headers: key ? { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' } : {},
    body: JSON.stringify(body),
  });

const seed: EmailAsk[] = [
  { message_id: 'm-done', status: 'done', received_at: '2026-01-05T00:00:00Z', created_at: '2026-01-05T00:00:00Z' },
  { message_id: 'm-needs', status: 'needs_you', received_at: '2026-01-02T00:00:00Z', created_at: '2026-01-02T00:00:00Z' },
  { message_id: 'm-drafted', status: 'drafted', received_at: '2026-01-04T00:00:00Z', created_at: '2026-01-04T00:00:00Z' },
  { message_id: 'm-dismissed', status: 'dismissed', received_at: '2026-01-03T00:00:00Z', created_at: '2026-01-03T00:00:00Z' },
];

describe('email asks route', () => {
  it('GET and POST return 404 when EMAIL_ASKS_KEY is unset', async () => {
    const e = env('', structuredClone(seed));
    expect((await app().fetch(get(''), e as never)).status).toBe(404);
    expect((await app().fetch(post('', 'm-needs', { status: 'done' }), e as never)).status).toBe(404);
  });

  it('GET and POST return 401 for a wrong bearer key', async () => {
    const e = env('secret', structuredClone(seed));
    expect((await app().fetch(get('nope'), e as never)).status).toBe(401);
    expect((await app().fetch(post('nope', 'm-needs', { status: 'done' }), e as never)).status).toBe(401);
  });

  it('GET lists only needs_you and drafted rows, newest first', async () => {
    const res = await app().fetch(get('secret'), env('secret', structuredClone(seed)) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { items: EmailAsk[] };
    expect(body.items.map((r) => r.message_id)).toEqual(['m-drafted', 'm-needs']);
  });

  it('POST marks a row done and it leaves the open list', async () => {
    const e = env('secret', structuredClone(seed));
    const res = await app().fetch(post('secret', 'm-needs', { status: 'done' }), e as never);
    expect(res.status).toBe(200);
    const list = await app().fetch(get('secret'), e as never);
    const body = (await list.json()) as { items: EmailAsk[] };
    expect(body.items.map((r) => r.message_id)).not.toContain('m-needs');
  });

  it('POST rejects any status other than done or dismissed', async () => {
    const e = env('secret', structuredClone(seed));
    const res = await app().fetch(post('secret', 'm-needs', { status: 'open' }), e as never);
    expect(res.status).toBe(400);
    const row = (e.DB.rows as EmailAsk[]).find((r) => r.message_id === 'm-needs');
    expect(row?.status).toBe('needs_you');
  });
});
