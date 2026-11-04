import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cardNamedFor, closeComment, closeInTrello, jobberRequestNumber, lostInTrello, matchCards, postponeComment, reopenInTrello,
  resetTrelloListCache, trelloClient, TrelloClient, type TrelloCard, type TrelloMove, type TrelloMoveStore,
} from '../../worker/src/services/trello-sync.js';
import { computeLeadWorkflow } from '../../worker/src/services/lead-workflow.js';

const LISTS = [
  { id: 'L_CALL', name: 'Requests to call' },
  { id: 'L_LOST', name: 'Bid Lost' },
  { id: 'L_PASS', name: 'Passed on job, referred out, follow up' },
];
const card = (id: string, name: string, idList: string, desc = ''): TrelloCard => ({ id, name, desc, idList, url: `https://trello.com/c/${id}` });
const auto = (id: string, person: string, requestNo: string, idList = 'L_CALL') =>
  card(id, `You received a new request from ${person}`, idList, `New Request\n\nView Request: https://secure.getjobber.com/work_requests/${requestNo}`);

const ANDREW = { jobberWebUri: 'https://secure.getjobber.com/work_requests/34977047', names: ['Andrew  Chris'] };
const BRYAN = { jobberWebUri: 'https://secure.getjobber.com/work_requests/35754222', names: ['Bryan Waters'] };

function memoryStore(): TrelloMoveStore & { moves: Map<string, TrelloMove & { restored: boolean }> } {
  const moves = new Map<string, TrelloMove & { restored: boolean }>();
  return {
    moves,
    active: async (requestId) => [...moves.entries()].filter(([k, m]) => k.startsWith(requestId + '|') && !m.restored).map(([, m]) => m),
    record: async (requestId, move) => { moves.set(`${requestId}|${move.cardId}`, { ...move, restored: false }); },
    restored: async (requestId, cardId) => { const m = moves.get(`${requestId}|${cardId}`); if (m) m.restored = true; },
  };
}

/** A fake Trello API: GET lists/cards, PUT card (move), POST comment. Records every call. */
function fakeTrello(cards: TrelloCard[], opts: { failMove?: boolean; failBoard?: number } = {}) {
  const calls: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const params = Object.fromEntries(url.searchParams.entries());
    const path = url.pathname.replace(/^\/1/, '');
    calls.push({ method, path, params });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (opts.failBoard && method === 'GET') return json({}, opts.failBoard);
    if (method === 'GET' && path.endsWith('/lists')) return json(LISTS);
    if (method === 'GET' && path.endsWith('/cards')) return json(cards);
    if (method === 'PUT') {
      if (opts.failMove) return json({}, 500);
      const c = cards.find((x) => path.endsWith(x.id))!;
      c.idList = params.idList;
      return json(c);
    }
    if (method === 'POST') return json({ id: 'action' });
    return json({}, 404);
  });
  return { client: new TrelloClient('KEY', 'TOKEN', fetchImpl as never), calls, fetchImpl };
}

describe('matching Trello cards to a Jobber request', () => {
  it('reads the request number from a Jobber link', () => {
    expect(jobberRequestNumber('https://secure.getjobber.com/work_requests/35172646')).toBe('35172646');
    expect(jobberRequestNumber(null)).toBeNull();
  });

  it('matches by the Jobber link in the description first', () => {
    const cards = [auto('a', 'Andrew Chris', '34977047'), card('b', 'Andrew Chris - Basement', 'L_CALL')];
    expect(matchCards(cards, ANDREW, new Set())).toMatchObject({ by: 'link', ambiguous: false, cards: [{ id: 'a' }] });
  });

  it('falls back to the client name at the start of a hand-made card', () => {
    const cards = [card('b', 'Bryan Waters - Wall Project (QB Referral)', 'L_CALL'), card('x', 'Bryan Watson - Deck', 'L_CALL')];
    expect(matchCards(cards, BRYAN, new Set())).toMatchObject({ by: 'name', ambiguous: false, cards: [{ id: 'b' }] });
    expect(cardNamedFor('You received a new request from Bryan Waters', 'Bryan Waters')).toBe(true);
    expect(cardNamedFor('Bryan Watersmith - Deck', 'Bryan Waters')).toBe(false);
  });

  it('never matches a card that links a different request', () => {
    const cards = [auto('o', 'Bryan Waters', '11111111')];
    expect(matchCards(cards, BRYAN, new Set()).cards).toHaveLength(0);
  });

  it('a name match is ambiguous with too many cards, or when another open lead has the same name', () => {
    const many = [card('1', 'Bryan Waters - A', 'L_CALL'), card('2', 'Bryan Waters - B', 'L_CALL'), card('3', 'Bryan Waters - C', 'L_CALL')];
    expect(matchCards(many, BRYAN, new Set())).toMatchObject({ ambiguous: true, cards: [] });
    const one = [card('1', 'Bryan Waters - A', 'L_CALL')];
    expect(matchCards(one, BRYAN, new Set(['bryan waters']))).toMatchObject({ ambiguous: true, candidates: [{ id: '1' }] });
    // Other open leads unknown: a name-only match is not trusted.
    expect(matchCards(one, BRYAN, null).ambiguous).toBe(true);
  });
});

describe('closing a lead in Trello', () => {
  beforeEach(() => resetTrelloListCache());

  it('without a key and token nothing is called and the team is reminded', async () => {
    expect(trelloClient({})).toBeNull();
    const r = await closeInTrello({ client: null, board: 'B', store: memoryStore(), requestId: 'R', who: ANDREW, otherOpenNames: new Set(), comment: 'x', postponed: false });
    expect(r).toMatchObject({ status: 'not_configured', message: expect.stringContaining('Also move the Trello card') });
  });

  it('moves every matching card to Bid Lost with a comment, and is safe to repeat', async () => {
    const cards = [auto('a', 'Bryan Waters', '35754222'), auto('b', 'Bryan Waters', '35754222')];
    const { client, calls } = fakeTrello(cards);
    const store = memoryStore();
    const input = { client, board: 'B', store, requestId: 'R', who: BRYAN, otherOpenNames: new Set<string>(), comment: closeComment('Denzel', 'No response', null), postponed: false };
    const r = await closeInTrello(input);
    expect(r).toMatchObject({ status: 'moved', message: 'Moved 2 Trello cards to Bid Lost.' });
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.params.idList)).toEqual(['L_LOST', 'L_LOST']);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.params.text)).toEqual(['Closed in Cotiza by Denzel — No response', 'Closed in Cotiza by Denzel — No response']);
    expect([...store.moves.values()].map((m) => m.fromListId)).toEqual(['L_CALL', 'L_CALL']);
    // Repeat: nothing moved or commented twice.
    const again = await closeInTrello(input);
    expect(again.status).toBe('already');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('says so when a move could not be recorded (reopen would not move it back)', async () => {
    const { client } = fakeTrello([auto('a', 'Bryan Waters', '35754222')]);
    const store = { ...memoryStore(), record: async () => { throw new Error('D1 down'); } };
    const r = await closeInTrello({ client, board: 'B', store, requestId: 'R', who: BRYAN, otherOpenNames: new Set(), comment: 'x', postponed: false });
    expect(r.status).toBe('moved');
    expect(r.message).toContain('couldn’t record it');
  });

  it('moves a card back to Bid Lost even if an old record says Cotiza moved it once', async () => {
    const cards = [auto('a', 'Bryan Waters', '35754222')];
    const { client } = fakeTrello(cards);
    const store = memoryStore();
    await store.record('R', { cardId: 'a', cardUrl: 'u', cardName: 'n', fromListId: 'L_CALL', toListId: 'L_LOST' }, 0);
    const r = await closeInTrello({ client, board: 'B', store, requestId: 'R', who: BRYAN, otherOpenNames: new Set(), comment: 'x', postponed: false });
    expect(r.status).toBe('moved');
    expect(cards[0].idList).toBe('L_LOST');
  });

  it('leaves a card already in Bid Lost alone', async () => {
    const { client, calls } = fakeTrello([auto('a', 'Andrew Chris', '34977047', 'L_LOST')]);
    const r = await closeInTrello({ client, board: 'B', store: memoryStore(), requestId: 'R', who: ANDREW, otherOpenNames: new Set(), comment: 'x', postponed: false });
    expect(r.status).toBe('already');
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('postponed: comments and does not move', async () => {
    const cards = [auto('a', 'Bryan Waters', '35754222')];
    const { client, calls } = fakeTrello(cards);
    const r = await closeInTrello({ client, board: 'B', store: memoryStore(), requestId: 'R', who: BRYAN, otherOpenNames: new Set(), comment: postponeComment('Denzel', '2027-02-04'), postponed: true });
    expect(r.status).toBe('commented');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(calls.find((c) => c.method === 'POST')!.params.text).toBe('Postponed in Cotiza by Denzel until 2027-02-04');
    expect(cards[0].idList).toBe('L_CALL');
  });

  it('ambiguous: moves nothing and lists the cards to move by hand', async () => {
    const { client, calls } = fakeTrello([card('1', 'Bryan Waters - A', 'L_CALL')]);
    const r = await closeInTrello({ client, board: 'B', store: memoryStore(), requestId: 'R', who: BRYAN, otherOpenNames: new Set(['bryan waters']), comment: 'x', postponed: false });
    expect(r).toMatchObject({ status: 'ambiguous', cards: [{ url: 'https://trello.com/c/1', done: false }] });
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('a Trello failure is reported with a reason, never hidden', async () => {
    const board = fakeTrello([], { failBoard: 401 });
    const r1 = await closeInTrello({ client: board.client, board: 'B', store: memoryStore(), requestId: 'R', who: BRYAN, otherOpenNames: new Set(), comment: 'x', postponed: false });
    expect(r1).toMatchObject({ status: 'failed', message: expect.stringContaining('HTTP 401') });
    resetTrelloListCache();
    const move = fakeTrello([auto('a', 'Bryan Waters', '35754222')], { failMove: true });
    const r2 = await closeInTrello({ client: move.client, board: 'B', store: memoryStore(), requestId: 'R', who: BRYAN, otherOpenNames: new Set(), comment: 'x', postponed: false });
    expect(r2).toMatchObject({ status: 'failed', cards: [{ done: false, error: expect.stringContaining('HTTP 500') }] });
  });

  it('never sends the key or token anywhere but Trello, and comments carry no contact details', async () => {
    expect(closeComment('Denzel', 'Other', 'call 773-555-0100 or a@b.com')).toBe('Closed in Cotiza by Denzel — Other: call [contact] or [contact]');
    const { client, fetchImpl } = fakeTrello([auto('a', 'Bryan Waters', '35754222')]);
    await closeInTrello({ client, board: 'B', store: memoryStore(), requestId: 'R', who: BRYAN, otherOpenNames: new Set(), comment: 'x', postponed: false });
    for (const [u] of fetchImpl.mock.calls) expect(new URL(String(u)).host).toBe('api.trello.com');
  });
});

describe('reopening a lead in Trello', () => {
  beforeEach(() => resetTrelloListCache());

  it('moves the cards Cotiza moved back to where they came from', async () => {
    const cards = [auto('a', 'Bryan Waters', '35754222')];
    const { client, calls } = fakeTrello(cards);
    const store = memoryStore();
    await closeInTrello({ client, board: 'B', store, requestId: 'R', who: BRYAN, otherOpenNames: new Set(), comment: 'x', postponed: false });
    expect(cards[0].idList).toBe('L_LOST');
    const r = await reopenInTrello({ client, store, requestId: 'R', comment: 'Reopened in Cotiza by Denzel' });
    expect(r).toMatchObject({ status: 'moved', message: 'Moved the Trello card back to where it was.' });
    expect(cards[0].idList).toBe('L_CALL');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.params.text)).toContain('Reopened in Cotiza by Denzel');
    expect(await store.active('R')).toHaveLength(0);
  });

  it('without Trello connected it says to move the card back by hand', async () => {
    const store = memoryStore();
    await store.record('R', { cardId: 'a', cardUrl: 'https://trello.com/c/a', cardName: 'Bryan', fromListId: 'L_CALL', toListId: 'L_LOST' }, 0);
    expect(await reopenInTrello({ client: null, store, requestId: 'R', comment: 'x' })).toMatchObject({ status: 'not_configured', cards: [{ url: 'https://trello.com/c/a' }] });
  });
});

describe('lost in Trello (the reverse check)', () => {
  const snapshot = (cards: TrelloCard[]) => ({ cards, lists: LISTS, bidLost: LISTS[1] });

  it('true only when every card linking the request is in Bid Lost', () => {
    expect(lostInTrello(snapshot([auto('a', 'Andrew Chris', '34977047', 'L_LOST')]), ANDREW.jobberWebUri)).toBe(true);
    expect(lostInTrello(snapshot([auto('a', 'Andrew Chris', '34977047', 'L_LOST'), auto('b', 'Andrew Chris', '34977047')]), ANDREW.jobberWebUri)).toBe(false);
    // A name-only card never counts: only the safe match.
    expect(lostInTrello(snapshot([card('n', 'Andrew Chris - X', 'L_LOST')]), ANDREW.jobberWebUri)).toBe(false);
    expect(lostInTrello(snapshot([]), ANDREW.jobberWebUri)).toBe(false);
  });

  it('puts the lead in Review with "Close in Cotiza too", never closing it by itself', () => {
    const w = computeLeadWorkflow({
      events: [{ at: '2026-10-11T21:07:00Z', channel: 'request', direction: 'incoming', source: 'jobber', label: 'Request came in' }],
      nextSet: null, info: { readyToQuote: false, total: 0, firstAsk: null }, hasTitle: false, notALead: false,
      lostInTrello: true, now: Date.parse('2026-11-04T16:00:00Z'),
    });
    expect(w).toMatchObject({ bucket: 'review', lostInTrello: true, closed: null, action: { kind: 'lost_in_trello', label: 'Close in Cotiza too' }, secondary: null });
  });
});
