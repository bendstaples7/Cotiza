import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CookCountyAssessorClient } from '../../worker/src/services/cook-county-assessor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchWithRecords(records: object[]) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => records,
  } as Response);
}

function mockFetchEmpty() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => [],
  } as Response);
}

// URLSearchParams encodes spaces as + and special chars — decode before asserting
function getDecodedUrl(fetchSpy: ReturnType<typeof vi.spyOn>): string {
  const raw = fetchSpy.mock.calls[0][0] as string;
  // Replace + with space before decoding (application/x-www-form-urlencoded style)
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}

// ---------------------------------------------------------------------------
// Address parsing / SODA query construction
// ---------------------------------------------------------------------------

describe('CookCountyAssessorClient.lookupByAddress — query construction', () => {
  let client: CookCountyAssessorClient;

  beforeEach(() => { client = new CookCountyAssessorClient(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('builds the correct SODA LIKE query for a full Jobber request.property address', async () => {
    const fetchSpy = mockFetchEmpty();
    await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL 60615');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(getDecodedUrl(fetchSpy)).toContain("upper(addr) like '5465 S HYDE PARK BLVD%'");
  });

  it('builds the correct SODA LIKE query for a north avenue address', async () => {
    const fetchSpy = mockFetchEmpty();
    await client.lookupByAddress('2345 North Michigan Avenue, Chicago, IL 60614');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(getDecodedUrl(fetchSpy)).toContain("upper(addr) like '2345 N MICHIGAN AVE%'");
  });

  it('builds the correct SODA LIKE query for a street address with full street-type word', async () => {
    const fetchSpy = mockFetchEmpty();
    await client.lookupByAddress('123 N Main Street, Chicago, IL 60601');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(getDecodedUrl(fetchSpy)).toContain("upper(addr) like '123 N MAIN ST%'");
  });

  it('strips unit/apt suffixes before querying', async () => {
    const fetchSpy = mockFetchEmpty();
    await client.lookupByAddress('456 West Oak Avenue Apt 3B, Chicago, IL');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = getDecodedUrl(fetchSpy);
    expect(url).toContain("upper(addr) like '456 W OAK AVE%'");
    expect(url).not.toContain('APT');
  });

  it('returns null and does not call fetch for a PO Box', async () => {
    const fetchSpy = mockFetchEmpty();
    const result = await client.lookupByAddress('PO Box 1234, Chicago, IL 60601');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null and does not call fetch for an address with no house number', async () => {
    const fetchSpy = mockFetchEmpty();
    const result = await client.lookupByAddress('Hyde Park Boulevard, Chicago, IL');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe('CookCountyAssessorClient.lookupByAddress — response parsing', () => {
  let client: CookCountyAssessorClient;

  beforeEach(() => { client = new CookCountyAssessorClient(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the first record with a valid bldg_sf', async () => {
    mockFetchWithRecords([
      { pin: '20-11-100-001-0000', addr: '5465 S HYDE PARK BLVD', bldg_sf: '3200', class: '299', town_code: '70', tax_year: '2023' },
      { pin: '20-11-100-001-0001', addr: '5465 S HYDE PARK BLVD', bldg_sf: '3200', class: '299', town_code: '70', tax_year: '2022' },
    ]);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(3200);
    expect(result!.pin).toBe('20-11-100-001-0000');
  });

  it('falls back to hd_sf for condo records where bldg_sf is absent', async () => {
    mockFetchWithRecords([
      { pin: '20-11-100-002-0000', addr: '5465 S HYDE PARK BLVD UNIT 4A', hd_sf: '1100', class: '399', town_code: '70', tax_year: '2023' },
    ]);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(1100);
  });

  it('returns null when all records have zero sqft', async () => {
    mockFetchWithRecords([
      { pin: '20-11-100-003-0000', addr: '5465 S HYDE PARK BLVD', bldg_sf: '0', class: '299', town_code: '70', tax_year: '2023' },
    ]);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).toBeNull();
  });

  it('returns null when the API returns an empty array', async () => {
    mockFetchEmpty();
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).toBeNull();
  });

  it('returns null on a non-OK HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sub-unit detection
// ---------------------------------------------------------------------------

describe('CookCountyAssessorClient.lookupByAddress — sub-unit detection', () => {
  let client: CookCountyAssessorClient;

  beforeEach(() => { client = new CookCountyAssessorClient(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const recordWithSqft = [
    { pin: '20-11-100-001-0000', addr: '5465 S HYDE PARK BLVD', bldg_sf: '3200', class: '299', town_code: '70', tax_year: '2023' },
  ];

  it('sets isSubUnit=true for an APT qualifier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => recordWithSqft } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Apt 2B, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=true for a UNIT qualifier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => recordWithSqft } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Unit 4A, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=true for a REAR qualifier (coach house)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => recordWithSqft } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Rear, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=true for a COACH HOUSE qualifier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => recordWithSqft } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Rear Coach House, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=true for a # qualifier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => recordWithSqft } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard #3, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=false for a plain address with no qualifier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => recordWithSqft } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(false);
  });

  it('divides by apts count when apts > 1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ pin: '20-11-100-001-0000', addr: '5465 S HYDE PARK BLVD', bldg_sf: '3000', apts: '3', class: '212', town_code: '70', tax_year: '2023' }],
    } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Unit 2, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(1000); // 3000 / 3
    expect(result!.unitCount).toBe(3);
  });

  it('uses 1/3 fallback for coach house when apts is 0 or 1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => recordWithSqft } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Rear Coach House, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(Math.round(3200 / 3));
  });

  it('uses 1/2 fallback for generic APT qualifier when apts is 0 or 1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => recordWithSqft } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Apt 2B, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(Math.round(3200 / 2));
  });
});

// ---------------------------------------------------------------------------
// Address preference: request.property vs client.clientProperties
//
// Mirrors the extraction logic fixed in quotes.ts to verify that
// request.property.address is preferred over client.clientProperties.
// ---------------------------------------------------------------------------

describe('Jobber address preference: request.property over client.clientProperties', () => {
  type JobberAddress = { street1?: string; street2?: string | null; city?: string; province?: string; postalCode?: string };

  /** Mirrors the fixed extraction logic from quotes.ts */
  function extractAddressFromJobberResponse(response: {
    request?: {
      property?: { address?: JobberAddress | null } | null;
      client?: { clientProperties?: { nodes?: Array<{ address?: JobberAddress }> } } | null;
    } | null;
  }): string | null {
    const requestPropertyAddress = response?.request?.property?.address;
    const clientPropertyAddress = response?.request?.client?.clientProperties?.nodes?.[0]?.address;
    const liveAddress = requestPropertyAddress ?? clientPropertyAddress;
    if (!liveAddress) return null;
    const parts = [liveAddress.street1, liveAddress.street2, liveAddress.city, liveAddress.province, liveAddress.postalCode]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  it('uses request.property.address when both are present', () => {
    const response = {
      request: {
        property: { address: { street1: '5465 South Hyde Park Boulevard', city: 'Chicago', province: 'IL', postalCode: '60615' } },
        client: { clientProperties: { nodes: [{ address: { street1: '123 N Michigan Ave', city: 'Chicago', province: 'IL', postalCode: '60601' } }] } },
      },
    };
    expect(extractAddressFromJobberResponse(response)).toBe('5465 South Hyde Park Boulevard, Chicago, IL, 60615');
  });

  it('falls back to client.clientProperties when request.property is null', () => {
    const response = {
      request: {
        property: null,
        client: { clientProperties: { nodes: [{ address: { street1: '123 N Michigan Ave', city: 'Chicago', province: 'IL', postalCode: '60601' } }] } },
      },
    };
    expect(extractAddressFromJobberResponse(response)).toBe('123 N Michigan Ave, Chicago, IL, 60601');
  });

  it('falls back to client.clientProperties when request.property.address is undefined', () => {
    const response = {
      request: {
        property: {},
        client: { clientProperties: { nodes: [{ address: { street1: '789 W Madison St', city: 'Chicago', province: 'IL', postalCode: '60661' } }] } },
      },
    };
    expect(extractAddressFromJobberResponse(response)).toBe('789 W Madison St, Chicago, IL, 60661');
  });

  it('returns null when both sources are absent', () => {
    const response = { request: { property: null, client: { clientProperties: { nodes: [] } } } };
    expect(extractAddressFromJobberResponse(response)).toBeNull();
  });

  it('returns null when the entire request is null', () => {
    expect(extractAddressFromJobberResponse({ request: null })).toBeNull();
  });

  it('regression: does NOT return client billing address when request.property is present', () => {
    // Before the fix, this would have returned the client billing address
    const response = {
      request: {
        property: { address: { street1: '5465 South Hyde Park Boulevard', city: 'Chicago', province: 'IL', postalCode: '60615' } },
        client: { clientProperties: { nodes: [{ address: { street1: '999 N Lake Shore Drive', city: 'Chicago', province: 'IL', postalCode: '60611' } }] } },
      },
    };
    const result = extractAddressFromJobberResponse(response);
    expect(result).toBe('5465 South Hyde Park Boulevard, Chicago, IL, 60615');
    expect(result).not.toContain('Lake Shore');
  });
});
