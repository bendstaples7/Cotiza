import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JobberWebSession, KEEPALIVE_TTL_MS, mergeSetCookies } from '../../worker/src/services/jobber-web-session.js';
import { JOBBER_SESSION_KEEPALIVE_CRON } from '../../worker/src/scheduled/jobber-session-keepalive.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const NOW = new Date('2026-10-29T12:00:00.000Z');

function jsonResponse(body: unknown, status = 200, setCookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const c of setCookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}

function sessionDb(row: { cookies: string; expires_at: string } | null) {
  const db = createMockD1();
  configurePrepareResults(db, [{ first: row }, {}]);
  return db;
}

describe('JobberWebSession.keepAlive', () => {
  it('extends a session Jobber still accepts, even past the local expiry', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { account: { id: 'acct-1' } } }));
    vi.stubGlobal('fetch', fetchMock);
    const db = sessionDb({ cookies: 'a=1; b=2', expires_at: '2026-10-29T08:00:00.000Z' });

    const result = await new JobberWebSession(db as never).keepAlive();

    expect(result).toBe('extended');
    expect(fetchMock.mock.calls[0][1].headers.Cookie).toBe('a=1; b=2');
    const update = db._stmts[1];
    expect(db.prepare.mock.calls[1][0]).toContain('UPDATE jobber_web_session');
    expect(db.prepare.mock.calls[1][0]).toContain('AND cookies = ?');
    expect(update.bind).toHaveBeenCalledWith('a=1; b=2', new Date(NOW.getTime() + KEEPALIVE_TTL_MS).toISOString(), 'a=1; b=2');
  });

  it('keeps a later expiry from a fresh login instead of shortening it', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: { account: { id: 'acct-1' } } })));
    const db = sessionDb({ cookies: 'a=1', expires_at: '2026-10-29T15:30:00.000Z' });

    await new JobberWebSession(db as never).keepAlive();

    expect(db._stmts[1].bind).toHaveBeenCalledWith('a=1', '2026-10-29T15:30:00.000Z', 'a=1');
  });

  it('stores cookies Jobber rotates during the check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { data: { account: { id: 'acct-1' } } }, 200,
      ['_session=new; path=/; HttpOnly', 'old=; Max-Age=0'],
    )));
    const db = sessionDb({ cookies: '_session=old; old=x; keep=y', expires_at: NOW.toISOString() });

    await new JobberWebSession(db as never).keepAlive();

    expect(db._stmts[1].bind.mock.calls[0][0]).toBe('_session=new; keep=y');
  });

  it.each([
    ['HTTP 401', () => jsonResponse({}, 401)],
    ['an unauthenticated GraphQL error', () => jsonResponse({ errors: [{ message: 'unauthenticated' }] })],
    ['no account data', () => jsonResponse({ data: { account: null } })],
  ])('clears the session when Jobber answers with %s', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    const db = sessionDb({ cookies: 'a=1', expires_at: NOW.toISOString() });

    const result = await new JobberWebSession(db as never).keepAlive();

    expect(result).toBe('expired');
    expect(db.prepare.mock.calls[1][0]).toContain("DELETE FROM jobber_web_session WHERE id = 'default' AND cookies = ?");
    expect(db._stmts[1].bind).toHaveBeenCalledWith('a=1');
  });

  it('leaves the session untouched when Jobber is unreachable or erroring', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const fetchImpl of [
      vi.fn().mockRejectedValue(new Error('network down')),
      vi.fn().mockResolvedValue(jsonResponse({}, 503)),
      vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'Internal error' }] })),
    ]) {
      vi.stubGlobal('fetch', fetchImpl);
      const db = sessionDb({ cookies: 'a=1', expires_at: NOW.toISOString() });

      expect(await new JobberWebSession(db as never).keepAlive()).toBe('error');
      expect(db.prepare).toHaveBeenCalledTimes(1);
    }
  });

  it('does nothing when no session is stored', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const db = sessionDb(null);

    expect(await new JobberWebSession(db as never).keepAlive()).toBe('missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('mergeSetCookies', () => {
  it('drops cookies Jobber expires with a past Expires date', () => {
    expect(mergeSetCookies('a=1; b=2', ['b=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])).toBe('a=1');
  });
});

describe('keep-alive cron', () => {
  it('is registered in wrangler.toml', () => {
    const wrangler = readFileSync(resolve(import.meta.dirname, '../../worker/wrangler.toml'), 'utf8');
    expect(wrangler).toContain(`"${JOBBER_SESSION_KEEPALIVE_CRON}"`);
  });
});
