import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestQueue } from '../../client/src/api';

afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchRequestQueue', () => {
  it('queue fetch asks for closed leads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ requests: [], jobber: { status: 'unavailable', days: 60 } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchRequestQueue('age_asc');

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('include_closed=true');
    expect(url).toContain('include_deathclock=true');
    expect(url).toContain('sort_by=age_asc');
  });
});
