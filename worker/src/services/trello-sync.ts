/**
 * Keeps the team's Trello board ("Chicago Reno Work Kanban") in step with Cotiza's lead closures, so
 * closing a lead in Cotiza is the only step:
 *
 * - Close (any reason but Postponed): the request's open Trello cards move to "Bid Lost", each with a
 *   "Closed in Cotiza by …" comment. Cards already in Bid Lost are left alone.
 * - Postponed: the card stays put and gets a "Postponed in Cotiza until …" comment.
 * - Reopen: cards Cotiza moved go back to the list they came from.
 * - The reverse: a lead whose cards (matched by the Jobber request link in the card description, the
 *   safe match) are all in Bid Lost is flagged so the queue can offer "Close in Cotiza too".
 *
 * Cards are found by the Jobber request link Jobber's automation writes into the description
 * ("View Request: https://secure.getjobber.com/work_requests/<id>"), then by the client's full name
 * at the start of a hand-made card ("Bryan Waters - Wall Project") or after "from " on an automated
 * one. A name-only match is skipped when it is ambiguous. Comments never carry contact details.
 * Needs TRELLO_API_KEY and TRELLO_TOKEN; without them nothing is called and the team is reminded to
 * move the card by hand.
 */
import { sanitizeLogText } from './jobber-log-sanitize.mjs';

export const TRELLO_API = 'https://api.trello.com/1';
/** The Chicago Reno Work Kanban board. TRELLO_BOARD_ID overrides it. */
export const DEFAULT_TRELLO_BOARD_ID = '666f4228ed669a8a7dc6062a';
export const BID_LOST_LIST = 'Bid Lost';
const TIMEOUT_MS = 10_000;
const LIST_CACHE_MS = 5 * 60_000;
/** More name-only matches than this is too many to be sure of. */
const MAX_NAME_MATCHES = 2;

export interface TrelloEnv { TRELLO_API_KEY?: string; TRELLO_TOKEN?: string; TRELLO_BOARD_ID?: string }
export interface TrelloCard { id: string; name: string; desc: string; idList: string; url: string }
export interface TrelloList { id: string; name: string }
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class TrelloError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'TrelloError'; }
}

export class TrelloClient {
  constructor(private key: string, private token: string, private fetchImpl: FetchLike = fetch) {}

  private async call<T>(method: 'GET' | 'PUT' | 'POST', path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(TRELLO_API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', this.key);
    url.searchParams.set('token', this.token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url.toString(), { method, signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new TrelloError(trelloFailureReason(res.status), res.status);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof TrelloError) throw err;
      throw new TrelloError('Trello could not be reached (network error or timeout).');
    } finally {
      clearTimeout(timer);
    }
  }

  lists(boardId: string) { return this.call<TrelloList[]>('GET', `/boards/${boardId}/lists`, { filter: 'open', fields: 'name' }); }
  cards(boardId: string) { return this.call<TrelloCard[]>('GET', `/boards/${boardId}/cards`, { filter: 'open', fields: 'name,desc,idList,url' }); }
  moveCard(cardId: string, listId: string) { return this.call<TrelloCard>('PUT', `/cards/${cardId}`, { idList: listId }); }
  comment(cardId: string, text: string) { return this.call<unknown>('POST', `/cards/${cardId}/actions/comments`, { text }); }
}

/** Maps a Trello HTTP status to a reason the team can act on. Never includes the key or token. */
export function trelloFailureReason(status: number | undefined): string {
  if (status === 401 || status === 403) return `Trello rejected Cotiza's key or token (HTTP ${status}). Check TRELLO_API_KEY and TRELLO_TOKEN on the Cotiza worker.`;
  if (status === 404) return 'Trello could not find the board or card (HTTP 404).';
  if (status === 429) return 'Trello is rate-limiting Cotiza (HTTP 429). Try again in a minute.';
  if (typeof status === 'number' && status >= 500) return `Trello had a server error (HTTP ${status}). Try again in a minute.`;
  return typeof status === 'number' ? `Trello refused the request (HTTP ${status}).` : 'Trello refused the request.';
}

export function trelloClient(env: TrelloEnv, fetchImpl?: FetchLike): TrelloClient | null {
  const key = env.TRELLO_API_KEY?.trim();
  const token = env.TRELLO_TOKEN?.trim();
  return key && token ? new TrelloClient(key, token, fetchImpl) : null;
}

export function boardId(env: TrelloEnv): string {
  return env.TRELLO_BOARD_ID?.trim() || DEFAULT_TRELLO_BOARD_ID;
}

// ── Matching cards to a Jobber request ──────────────────────────

/** The numeric Jobber request id at the end of a jobberWebUri (https://secure.getjobber.com/work_requests/35172646). */
export function jobberRequestNumber(jobberWebUri: string | null | undefined): string | null {
  const m = /\/work_requests\/(\d+)\b/.exec(jobberWebUri ?? '');
  return m ? m[1] : null;
}

/** The Jobber request number a card's description links to, if any. */
export function cardRequestNumber(card: Pick<TrelloCard, 'desc'>): string | null {
  return jobberRequestNumber(card.desc);
}

export function normalizeName(name: string | null | undefined): string {
  return (name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when the card is named for this person: "<Name> - …", "<Name> (…", "<Name>" or "… from <Name>". */
export function cardNamedFor(cardName: string, person: string): boolean {
  const n = normalizeName(cardName);
  const p = normalizeName(person);
  if (p.split(' ').length < 2) return false; // a first name alone matches too much
  if (n === p) return true;
  if (n.startsWith(p) && /^\s*[-–—(:|,]/.test(n.slice(p.length))) return true;
  const from = n.lastIndexOf(' from ');
  return from >= 0 && n.slice(from + 6).trim() === p;
}

export interface RequestIdentity {
  /** The request's Jobber link (for the safe match). */
  jobberWebUri: string | null;
  /** Person names to try for a name match: client first + last, the request's contact name. */
  names: string[];
}

export interface CardMatch {
  cards: TrelloCard[];
  by: 'link' | 'name' | 'none';
  /** Name-only matches that could belong to someone else: nothing should be moved. */
  ambiguous: boolean;
  /** Possible cards when ambiguous, for the "move it by hand" links. */
  candidates: TrelloCard[];
}

/**
 * The request's open cards: those whose description links this Jobber request; otherwise cards named
 * for the client that don't link a different request. otherOpenNames are the client names of the
 * other open leads (null when unknown): a name shared with another open lead is ambiguous.
 */
export function matchCards(cards: TrelloCard[], who: RequestIdentity, otherOpenNames: Set<string> | null): CardMatch {
  const number = jobberRequestNumber(who.jobberWebUri);
  if (number) {
    const linked = cards.filter((c) => cardRequestNumber(c) === number);
    if (linked.length > 0) return { cards: linked, by: 'link', ambiguous: false, candidates: [] };
  }
  const names = [...new Set(who.names.map(normalizeName).filter((n) => n.split(' ').length >= 2))];
  const named = cards.filter((c) => !cardRequestNumber(c) || cardRequestNumber(c) === number)
    .filter((c) => names.some((p) => cardNamedFor(c.name, p)));
  if (named.length === 0) return { cards: [], by: 'none', ambiguous: false, candidates: [] };
  const collides = otherOpenNames === null || names.some((p) => otherOpenNames.has(p));
  if (named.length > MAX_NAME_MATCHES || collides) return { cards: [], by: 'name', ambiguous: true, candidates: named };
  return { cards: named, by: 'name', ambiguous: false, candidates: [] };
}

// ── Board snapshot ─────────────────────────────────────────────

let listCache: { board: string; at: number; lists: TrelloList[] } | null = null;

/** The board's lists by name, cached for a few minutes (list ids rarely change). */
export async function boardLists(client: TrelloClient, board: string, now: number = Date.now()): Promise<TrelloList[]> {
  if (listCache && listCache.board === board && now - listCache.at < LIST_CACHE_MS) return listCache.lists;
  const lists = await client.lists(board);
  if (!Array.isArray(lists)) throw new TrelloError('Trello returned no lists for the board.');
  listCache = { board, at: now, lists };
  return lists;
}

export function resetTrelloListCache() { listCache = null; }

export function listByName(lists: TrelloList[], name: string): TrelloList | null {
  const want = normalizeName(name);
  return lists.find((l) => normalizeName(l.name) === want) ?? null;
}

export interface BoardSnapshot { cards: TrelloCard[]; lists: TrelloList[]; bidLost: TrelloList | null }

export async function boardSnapshot(client: TrelloClient, board: string): Promise<BoardSnapshot> {
  const [lists, cards] = await Promise.all([boardLists(client, board), client.cards(board)]);
  if (!Array.isArray(cards)) throw new TrelloError('Trello returned no cards for the board.');
  return { cards, lists, bidLost: listByName(lists, BID_LOST_LIST) };
}

/**
 * The reverse check, by Jobber link only: true when every card linking this request is in Bid Lost
 * (and there is at least one). False when no card links it.
 */
export function lostInTrello(snapshot: BoardSnapshot, jobberWebUri: string | null | undefined): boolean {
  const number = jobberRequestNumber(jobberWebUri);
  if (!number || !snapshot.bidLost) return false;
  const linked = snapshot.cards.filter((c) => cardRequestNumber(c) === number);
  return linked.length > 0 && linked.every((c) => c.idList === snapshot.bidLost!.id);
}

// ── Close / postpone / reopen ───────────────────────────────────

export type TrelloOutcome =
  | 'not_configured' // no Trello key/token: move the card by hand
  | 'moved'          // cards moved to Bid Lost (or back, on reopen)
  | 'commented'      // postponed: a comment was added, nothing moved
  | 'already'        // every matching card was already where it belongs
  | 'none_found'     // no card for this request on the board
  | 'ambiguous'      // couldn't tell which card: move it by hand
  | 'partial'        // some cards done, some failed
  | 'failed';        // Trello could not be read or written

export interface TrelloCardResult { name: string; url: string; done: boolean; error?: string }
export interface TrelloResult { status: TrelloOutcome; message: string; cards: TrelloCardResult[] }

/** One card Cotiza moved, so a reopen can move it back. */
export interface TrelloMove { cardId: string; cardUrl: string; cardName: string; fromListId: string; toListId: string }

export interface TrelloMoveStore {
  /** Cards Cotiza moved for this request that are not back yet. */
  active(requestId: string): Promise<TrelloMove[]>;
  record(requestId: string, move: TrelloMove, now: number): Promise<void>;
  restored(requestId: string, cardId: string, now: number): Promise<void>;
}

const MESSAGES: Record<TrelloOutcome, string> = {
  not_configured: 'Trello is not connected to Cotiza. Also move the Trello card.',
  moved: 'Moved the Trello card to Bid Lost.',
  commented: 'Added a note to the Trello card. It stays where it is.',
  already: 'The Trello card was already in Bid Lost.',
  none_found: 'No Trello card for this request was found. Nothing to move.',
  ambiguous: 'Couldn’t tell which Trello card is this lead’s. Move it by hand.',
  partial: 'Some Trello cards could not be moved. Move the rest by hand.',
  failed: 'Trello could not be updated. Move the card by hand.',
};

function result(status: TrelloOutcome, cards: TrelloCardResult[] = [], detail?: string): TrelloResult {
  return { status, cards, message: detail ? `${MESSAGES[status]} ${detail}` : MESSAGES[status] };
}

function reason(err: unknown): string {
  return err instanceof TrelloError ? err.message : 'Trello could not be updated.';
}

export interface CloseInTrelloInput {
  client: TrelloClient | null;
  board: string;
  store: TrelloMoveStore;
  requestId: string;
  who: RequestIdentity;
  otherOpenNames: Set<string> | null;
  /** "Closed in Cotiza by Denzel — Went with someone else". No contact details. */
  comment: string;
  /** Postponed: comment only, no move. */
  postponed: boolean;
  now?: number;
}

/**
 * Moves the request's cards to Bid Lost (or comments, when postponed). Safe to repeat: a card
 * already in Bid Lost is left alone and gets no second comment.
 */
export async function closeInTrello(input: CloseInTrelloInput): Promise<TrelloResult> {
  const { client, board, store, requestId, who, comment, postponed } = input;
  const now = input.now ?? Date.now();
  if (!client) return result('not_configured');
  let snapshot: BoardSnapshot;
  try {
    snapshot = await boardSnapshot(client, board);
  } catch (err) {
    logFailure('read board', err);
    return result('failed', [], reason(err));
  }
  if (!snapshot.bidLost && !postponed) return result('failed', [], `The board has no "${BID_LOST_LIST}" list.`);
  const match = matchCards(snapshot.cards, who, input.otherOpenNames);
  if (match.ambiguous) return result('ambiguous', match.candidates.map((c) => ({ name: c.name, url: c.url, done: false })));
  if (match.cards.length === 0) return result('none_found');

  const done: TrelloCardResult[] = [];
  if (postponed) {
    for (const card of match.cards) {
      try {
        await client.comment(card.id, comment);
        done.push({ name: card.name, url: card.url, done: true });
      } catch (err) {
        logFailure('comment', err);
        done.push({ name: card.name, url: card.url, done: false, error: reason(err) });
      }
    }
    return summarize(done, 'commented');
  }

  // Trello's own state decides what to move: a card outside Bid Lost is moved even if an older
  // record says Cotiza moved it once (it was moved back by hand, or its restore wasn't recorded).
  const bidLost = snapshot.bidLost!;
  const toMove = match.cards.filter((c) => c.idList !== bidLost.id);
  if (toMove.length === 0) {
    return result('already', match.cards.map((c) => ({ name: c.name, url: c.url, done: true })));
  }
  for (const card of toMove) {
    try {
      await client.moveCard(card.id, bidLost.id);
      // Recorded right after the move so a reopen can move it back, even if the comment fails.
      const recorded = await store.record(requestId, { cardId: card.id, cardUrl: card.url, cardName: card.name, fromListId: card.idList, toListId: bidLost.id }, now)
        .then(() => true, (err) => { logFailure('record move', err); return false; });
      const commented = await client.comment(card.id, comment).then(() => true, (err) => { logFailure('comment', err); return false; });
      const problems = [
        recorded ? null : 'Cotiza couldn\u2019t record the move, so reopening won\u2019t move it back',
        commented ? null : 'the \u201cClosed in Cotiza\u201d comment couldn\u2019t be added',
      ].filter(Boolean);
      done.push(problems.length === 0
        ? { name: card.name, url: card.url, done: true }
        : { name: card.name, url: card.url, done: true, error: `moved, but ${problems.join(' and ')}` });
    } catch (err) {
      logFailure('move', err);
      done.push({ name: card.name, url: card.url, done: false, error: reason(err) });
    }
  }
  return summarize(done, 'moved');
}

export interface ReopenInTrelloInput {
  client: TrelloClient | null;
  store: TrelloMoveStore;
  requestId: string;
  /** "Reopened in Cotiza by Denzel". */
  comment: string;
  now?: number;
}

/** Moves the cards Cotiza moved for this request back to the lists they came from. */
export async function reopenInTrello(input: ReopenInTrelloInput): Promise<TrelloResult> {
  const { client, store, requestId, comment } = input;
  const now = input.now ?? Date.now();
  let moves: TrelloMove[];
  try {
    moves = await store.active(requestId);
  } catch (err) {
    logFailure('read moves', err);
    return result('failed', [], 'Cotiza could not read which Trello cards it moved.');
  }
  if (moves.length === 0) {
    return client
      ? { status: 'none_found', cards: [], message: 'Cotiza had not moved a Trello card for this lead, so nothing moved back.' }
      : result('not_configured');
  }
  if (!client) {
    return { status: 'not_configured', message: 'Trello is not connected to Cotiza. Move the Trello card back by hand.', cards: moves.map((m) => ({ name: m.cardName, url: m.cardUrl, done: false })) };
  }
  const done: TrelloCardResult[] = [];
  for (const move of moves) {
    try {
      await client.moveCard(move.cardId, move.fromListId);
      const recorded = await store.restored(requestId, move.cardId, now)
        .then(() => true, (err) => { logFailure('record restore', err); return false; });
      await client.comment(move.cardId, comment).catch((err) => logFailure('comment', err));
      done.push(recorded
        ? { name: move.cardName, url: move.cardUrl, done: true }
        : { name: move.cardName, url: move.cardUrl, done: true, error: 'moved back, but Cotiza couldn\u2019t record it' });
    } catch (err) {
      logFailure('restore', err);
      done.push({ name: move.cardName, url: move.cardUrl, done: false, error: reason(err) });
    }
  }
  const outcome = summarize(done, 'moved');
  if (outcome.status === 'moved') outcome.message = done.length === 1 ? 'Moved the Trello card back to where it was.' : 'Moved the Trello cards back to where they were.';
  return outcome;
}

function summarize(cards: TrelloCardResult[], ok: 'moved' | 'commented'): TrelloResult {
  const good = cards.filter((c) => c.done).length;
  if (good === cards.length) {
    const r = result(ok, cards);
    if (ok === 'moved' && cards.length > 1) r.message = `Moved ${cards.length} Trello cards to Bid Lost.`;
    // Done in Trello but not recorded in Cotiza: say so rather than reporting a clean success.
    const unrecorded = cards.filter((c) => c.error);
    if (unrecorded.length > 0) r.message += ` Note: ${unrecorded.map((c) => c.error).join('; ')}.`;
    return r;
  }
  return good === 0 ? result('failed', cards, cards.find((c) => c.error)?.error) : result('partial', cards);
}

function logFailure(what: string, err: unknown) {
  console.warn(`[trello] ${what} failed: ${sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180)}`);
}

// ── Comments ───────────────────────────────────────────────────

/** Comment text, never with contact details (only the reason label and the team's short note). */
export function closeComment(user: string, reasonLabel: string, note: string | null): string {
  const clean = (note ?? '').replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '[contact]')
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, '[contact]').trim().slice(0, 200);
  return `Closed in Cotiza by ${user} — ${reasonLabel}${clean ? `: ${clean}` : ''}`;
}

export function postponeComment(user: string, checkBackOn: string | null): string {
  return `Postponed in Cotiza by ${user}${checkBackOn ? ` until ${checkBackOn}` : ''}`;
}

export function reopenComment(user: string): string {
  return `Reopened in Cotiza by ${user}`;
}

// ── D1 store ───────────────────────────────────────────────────

export class D1TrelloMoveStore implements TrelloMoveStore {
  constructor(private db: D1Database) {}

  async active(requestId: string): Promise<TrelloMove[]> {
    const { results } = await this.db
      .prepare('SELECT card_id, card_url, card_name, from_list_id, to_list_id FROM lead_trello_moves WHERE jobber_request_id = ? AND restored_at IS NULL ORDER BY moved_at')
      .bind(requestId)
      .all<{ card_id: string; card_url: string; card_name: string; from_list_id: string; to_list_id: string }>();
    return (results ?? []).map((r) => ({ cardId: r.card_id, cardUrl: r.card_url, cardName: r.card_name, fromListId: r.from_list_id, toListId: r.to_list_id }));
  }

  async record(requestId: string, move: TrelloMove, now: number): Promise<void> {
    const at = new Date(now).toISOString();
    await this.db
      .prepare(`INSERT INTO lead_trello_moves (jobber_request_id, card_id, card_url, card_name, from_list_id, to_list_id, moved_at, restored_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(jobber_request_id, card_id) DO UPDATE SET card_url = excluded.card_url, card_name = excluded.card_name,
                  from_list_id = excluded.from_list_id, to_list_id = excluded.to_list_id, moved_at = excluded.moved_at, restored_at = NULL`)
      .bind(requestId, move.cardId, move.cardUrl, move.cardName.slice(0, 300), move.fromListId, move.toListId, at)
      .run();
  }

  async restored(requestId: string, cardId: string, now: number): Promise<void> {
    await this.db
      .prepare('UPDATE lead_trello_moves SET restored_at = ? WHERE jobber_request_id = ? AND card_id = ? AND restored_at IS NULL')
      .bind(new Date(now).toISOString(), requestId, cardId)
      .run();
  }
}
