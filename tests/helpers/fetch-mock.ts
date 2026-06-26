import { vi } from 'vitest';

/**
 * Reusable mock for the global `fetch` — the external HTTP boundary.
 *
 * Lets integration tests register handlers per URL (substring / regex / fn) and
 * inspect the calls that were made. This is the harness that makes the
 * "happy path passes but the error path is broken" class of bug testable:
 * register the real success AND failure response shapes of OpenAI / Graph /
 * Jobber / GitHub and drive the pipeline code through them.
 */

export interface MockResponseSpec {
  status?: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

type UrlMatcher = string | RegExp | ((url: string, init: RequestInit) => boolean);
type SpecFactory = MockResponseSpec | ((url: string, init: RequestInit) => MockResponseSpec);

function makeResponse(spec: MockResponseSpec): Response {
  const status = spec.status ?? 200;
  const ok = spec.ok ?? (status >= 200 && status < 300);
  const bodyText = spec.text ?? (spec.json !== undefined ? JSON.stringify(spec.json) : '');
  const bodyBytes = new TextEncoder().encode(bodyText);
  return {
    ok,
    status,
    json: async () => (spec.json !== undefined ? spec.json : JSON.parse(bodyText || 'null')),
    text: async () => bodyText,
    arrayBuffer: async () => bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength),
    headers: new Headers(spec.headers ?? {}),
  } as unknown as Response;
}

function toMatcher(match: UrlMatcher): (url: string, init: RequestInit) => boolean {
  if (typeof match === 'function') return match;
  if (match instanceof RegExp) return (url) => match.test(url);
  return (url) => url.includes(match);
}

export interface FetchMock {
  spy: ReturnType<typeof vi.spyOn>;
  calls: RecordedCall[];
  /** Register a handler. First matching handler wins. */
  on(match: UrlMatcher, spec: SpecFactory): FetchMock;
  /** Calls whose URL includes the given substring. */
  callsTo(substring: string): RecordedCall[];
  restore(): void;
}

export function installFetchMock(): FetchMock {
  const handlers: Array<{ match: (url: string, init: RequestInit) => boolean; spec: SpecFactory }> = [];
  const calls: RecordedCall[] = [];

  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: request.url,
      method: request.method.toUpperCase(),
      body: typeof init.body === 'string' ? init.body : undefined,
      headers,
    });

    const handler = handlers.find((h) => h.match(request.url, init));
    if (!handler) {
      throw new Error(`installFetchMock: no handler registered for ${request.method.toUpperCase()} ${request.url}`);
    }
    const spec = typeof handler.spec === 'function' ? handler.spec(request.url, init) : handler.spec;
    return makeResponse(spec);
  };

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);

  const mock: FetchMock = {
    spy,
    calls,
    on(match, spec) {
      handlers.push({ match: toMatcher(match), spec });
      return mock;
    },
    callsTo(substring) {
      return calls.filter((c) => c.url.includes(substring));
    },
    restore() {
      spy.mockRestore();
    },
  };
  return mock;
}
