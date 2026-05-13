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
function getDecodedUrl(fetchSpy: ReturnType<typeof vi.spyOn>, callIndex = 0): string {
  const raw = fetchSpy.mock.calls[callIndex][0] as string;
  // Replace + with space before decoding (application/x-www-form-urlencoded style)
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}

/** Census geocoder response for a Chicago address */
function censusResponse(lat: number, lng: number) {
  return {
    ok: true,
    json: async () => ({
      result: {
        addressMatches: [{ coordinates: { x: lng, y: lat } }],
      },
    }),
  } as Response;
}

/** Parcel location response with a single PIN */
function parcelResponse(pin: string, lat: number, lng: number) {
  return {
    ok: true,
    json: async () => ([{ pin, property_address: '2307 W MELROSE ST', latitude: String(lat), longitude: String(lng) }]),
  } as Response;
}

/** Assessor record response */
function assessorResponse(records: object[]) {
  return {
    ok: true,
    json: async () => records,
  } as Response;
}

/**
 * Mock fetch for the full geocode → PIN → assessor pipeline.
 * Call order: 1=Census geocoder, 2=parcel lookup, 3=assessor by PIN.
 */
function mockFullPipeline(
  lat: number,
  lng: number,
  pin: string,
  assessorRecords: object[],
) {
  return vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(censusResponse(lat, lng))
    .mockResolvedValueOnce(parcelResponse(pin, lat, lng))
    .mockResolvedValueOnce(assessorResponse(assessorRecords));
}

// ---------------------------------------------------------------------------
// Address parsing / SODA query construction
// ---------------------------------------------------------------------------

describe('CookCountyAssessorClient.lookupByAddress — query construction', () => {
  let client: CookCountyAssessorClient;

  beforeEach(() => { client = new CookCountyAssessorClient(); });
  afterEach(() => { vi.restoreAllMocks(); });

  /**
   * For fallback-path tests, mock the geocoder to return no match so the
   * address-string LIKE query runs. The second call is the assessor fallback.
   */
  function mockGeocodeFail() {
    return vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValue({ ok: true, json: async () => [] } as Response);
  }

  it('builds the correct SODA LIKE query for a full Jobber request.property address', async () => {
    const fetchSpy = mockGeocodeFail();
    await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL 60615');
    // call[0] = geocoder, call[1] = assessor fallback
    expect(getDecodedUrl(fetchSpy, 1)).toContain("upper(addr) like '5465 S HYDE PARK BLVD%'");
  });

  it('builds the correct SODA LIKE query for a north avenue address', async () => {
    const fetchSpy = mockGeocodeFail();
    await client.lookupByAddress('2345 North Michigan Avenue, Chicago, IL 60614');
    expect(getDecodedUrl(fetchSpy, 1)).toContain("upper(addr) like '2345 N MICHIGAN AVE%'");
  });

  it('builds the correct SODA LIKE query for a street address with full street-type word', async () => {
    const fetchSpy = mockGeocodeFail();
    await client.lookupByAddress('123 N Main Street, Chicago, IL 60601');
    expect(getDecodedUrl(fetchSpy, 1)).toContain("upper(addr) like '123 N MAIN ST%'");
  });

  it('strips unit/apt suffixes before querying', async () => {
    const fetchSpy = mockGeocodeFail();
    await client.lookupByAddress('456 West Oak Avenue Apt 3B, Chicago, IL');
    const url = getDecodedUrl(fetchSpy, 1);
    expect(url).toContain("upper(addr) like '456 W OAK AVE%'");
    expect(url).not.toContain('APT');
  });

  it('returns null and does not call fetch for a PO Box', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] } as Response);
    const result = await client.lookupByAddress('PO Box 1234, Chicago, IL 60601');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null and does not call fetch for an address with no house number', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] } as Response);
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

  /** Geocoder fails → fallback path with given assessor records */
  function mockFallbackWithRecords(records: object[]) {
    return vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => records } as Response);
  }

  it('returns the first record with a valid bldg_sf', async () => {
    mockFallbackWithRecords([
      { pin: '20-11-100-001-0000', addr: '5465 S HYDE PARK BLVD', bldg_sf: '3200', class: '299', town_code: '70', tax_year: '2023' },
      { pin: '20-11-100-001-0001', addr: '5465 S HYDE PARK BLVD', bldg_sf: '3200', class: '299', town_code: '70', tax_year: '2022' },
    ]);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(3200);
    expect(result!.pin).toBe('20-11-100-001-0000');
  });

  it('falls back to hd_sf for condo records where bldg_sf is absent', async () => {
    mockFallbackWithRecords([
      { pin: '20-11-100-002-0000', addr: '5465 S HYDE PARK BLVD UNIT 4A', hd_sf: '1100', class: '399', town_code: '70', tax_year: '2023' },
    ]);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(1100);
  });

  it('returns null when all records have zero sqft', async () => {
    mockFallbackWithRecords([
      { pin: '20-11-100-003-0000', addr: '5465 S HYDE PARK BLVD', bldg_sf: '0', class: '299', town_code: '70', tax_year: '2023' },
    ]);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).toBeNull();
  });

  it('returns null when the API returns an empty array', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).toBeNull();
  });

  it('returns null on a non-OK HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response);
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

  /** Geocoder fails → fallback path with given assessor records */
  function mockFallback(records: object[]) {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => records } as Response);
  }

  it('sets isSubUnit=true for an APT qualifier', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Apt 2B, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=true for a UNIT qualifier', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Unit 4A, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=true for a REAR qualifier (coach house)', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Rear, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=true for a COACH HOUSE qualifier', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Rear Coach House, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=true for a # qualifier', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard #3, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(true);
  });

  it('sets isSubUnit=false for a plain address with no qualifier', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.isSubUnit).toBe(false);
  });

  it('divides by apts count when apts > 1', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [{ pin: '20-11-100-001-0000', addr: '5465 S HYDE PARK BLVD', bldg_sf: '3000', apts: '3', class: '212', town_code: '70', tax_year: '2023' }] } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Unit 2, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(1000); // 3000 / 3
    expect(result!.unitCount).toBe(3);
  });

  it('uses 1/3 fallback for coach house when apts is 0 or 1', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Rear Coach House, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(Math.round(3200 / 3));
  });

  it('uses 1/2 fallback for generic APT qualifier when apts is 0 or 1', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Apt 2B, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(Math.round(3200 / 2));
  });

  // ── totalSqft / structuralQualifier passthrough ──────────────────────────
  // These assertions exist specifically to catch regressions where the raw
  // building total is computed but not returned, causing the UI to be unable
  // to show "X sq ft (est. unit) · Y sq ft total property".

  it('exposes totalSqft on the record when a structural divisor was applied (coach house)', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Rear Coach House, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.totalSqft).toBe(3200);           // raw total before ÷3
    expect(result!.structuralQualifier).toBe(true);
  });

  it('exposes totalSqft on the record when a generic unit divisor was applied (APT)', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Apt 2B, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.totalSqft).toBe(3200);           // raw total before ÷2
    expect(result!.structuralQualifier).toBeFalsy(); // APT is not a structural qualifier
  });

  it('exposes totalSqft when divided by known unit count', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [{ pin: '20-11-100-001-0000', addr: '5465 S HYDE PARK BLVD', bldg_sf: '3000', apts: '3', class: '212', town_code: '70', tax_year: '2023' }] } as Response);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard Unit 2, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(1000);  // 3000 / 3
    expect(result!.totalSqft).toBe(3000);     // raw total preserved
  });

  it('does NOT set totalSqft when no divisor was applied (plain address)', async () => {
    mockFallback(recordWithSqft);
    const result = await client.lookupByAddress('5465 South Hyde Park Boulevard, Chicago, IL');
    expect(result).not.toBeNull();
    expect(result!.totalSqft).toBeUndefined();      // no divisor → no separate total
    expect(result!.structuralQualifier).toBeFalsy();
  });

  it('back-calculates estimated total from hd_sf for a coach house when bldg_sf is absent', async () => {
    // Simulates the real-world case: assessor has hd_sf only (class 299 condo record)
    // For a coach house, estimated total = hd_sf × 3
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [
        { pin: '14193280371001', addr: '2307 W MELROSE ST', hd_sf: '3125', class: '299', town_code: '73', tax_year: '2019' },
      ] } as Response);
    const result = await client.lookupByAddress('2307 West Melrose Street, Rear Coach House, Chicago, IL 60618');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(3125);              // hd_sf is the unit sqft
    expect(result!.totalSqft).toBe(9375);                 // 3125 × 3 estimated total
    expect(result!.structuralQualifier).toBe(true);
    expect(result!.isSubUnit).toBe(true);
  });

  it('back-calculates estimated total from hd_sf for a generic APT when bldg_sf is absent', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [
        { pin: '14193280371001', addr: '2307 W MELROSE ST', hd_sf: '1200', class: '299', town_code: '73', tax_year: '2019' },
      ] } as Response);
    const result = await client.lookupByAddress('2307 West Melrose Street, Apt 2, Chicago, IL 60618');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(1200);              // hd_sf is the unit sqft
    expect(result!.totalSqft).toBe(2400);                 // 1200 × 2 estimated total
    expect(result!.structuralQualifier).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Geocode → PIN → assessor pipeline
// ---------------------------------------------------------------------------

describe('CookCountyAssessorClient.lookupByAddress — geocode → PIN pipeline', () => {
  let client: CookCountyAssessorClient;

  beforeEach(() => { client = new CookCountyAssessorClient(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses the PIN path when geocoding succeeds and returns a valid assessor record', async () => {
    const fetchSpy = mockFullPipeline(
      41.9403, -87.6860,
      '14193280371001',
      [{ pin: '14193280371001', addr: '2307 W MELROSE ST', bldg_sf: '9375', class: '211', town_code: '77', tax_year: '2023' }],
    );
    const result = await client.lookupByAddress('2307 West Melrose Street, Rear Coach House, Chicago, IL 60618');
    expect(result).not.toBeNull();
    expect(result!.pin).toBe('14193280371001');
    expect(result!.buildingSqft).toBe(Math.round(9375 / 3)); // structural qualifier → ÷3
    expect(result!.totalSqft).toBe(9375);
    expect(result!.structuralQualifier).toBe(true);
    // Verify PIN query was used (call[2] should contain pin=14193280371001)
    expect(getDecodedUrl(fetchSpy, 2)).toContain('pin=14193280371001');
  });

  it('picks the closest parcel when multiple parcels are in the bounding box', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(censusResponse(41.9403, -87.6860))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { pin: '14193280371001', latitude: '41.9403', longitude: '-87.6860' }, // closest
          { pin: '14193280150000', latitude: '41.9415', longitude: '-87.6875' }, // farther
        ]),
      } as Response)
      .mockResolvedValueOnce(assessorResponse([
        { pin: '14193280371001', addr: '2307 W MELROSE ST', bldg_sf: '9375', class: '211', town_code: '77', tax_year: '2023' },
      ]));
    const result = await client.lookupByAddress('2307 West Melrose Street, Chicago, IL 60618');
    expect(result).not.toBeNull();
    expect(result!.pin).toBe('14193280371001');
  });

  it('falls back to address-string query when geocoder returns no match', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { addressMatches: [] } }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ pin: '14193280371001', addr: '2307 W MELROSE ST', bldg_sf: '9375', class: '211', town_code: '77', tax_year: '2023' }],
      } as Response);
    const result = await client.lookupByAddress('2307 West Melrose Street, Chicago, IL 60618');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(9375);
    // call[1] should be the address-string fallback query
    expect(getDecodedUrl(fetchSpy, 1)).toContain("upper(addr) like '2307 W MELROSE ST%'");
  });

  it('falls back to address-string query when parcel lookup returns no results', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(censusResponse(41.9403, -87.6860))
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response) // parcel: empty
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ pin: '14193280371001', addr: '2307 W MELROSE ST', bldg_sf: '9375', class: '211', town_code: '77', tax_year: '2023' }],
      } as Response);
    const result = await client.lookupByAddress('2307 West Melrose Street, Chicago, IL 60618');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(9375);
    expect(getDecodedUrl(fetchSpy, 2)).toContain("upper(addr) like '2307 W MELROSE ST%'");
  });

  it('falls back to address-string query when geocoder call throws', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ pin: '14193280371001', addr: '2307 W MELROSE ST', bldg_sf: '9375', class: '211', town_code: '77', tax_year: '2023' }],
      } as Response);
    const result = await client.lookupByAddress('2307 West Melrose Street, Chicago, IL 60618');
    expect(result).not.toBeNull();
    expect(result!.buildingSqft).toBe(9375);
    expect(getDecodedUrl(fetchSpy, 1)).toContain("upper(addr) like '2307 W MELROSE ST%'");
  });

  it('geocodeAddress returns null when Census API returns no matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { addressMatches: [] } }),
    } as Response);
    const result = await client.geocodeAddress('2307 West Melrose Street, Chicago, IL 60618');
    expect(result).toBeNull();
  });

  it('geocodeAddress returns lat/lng when Census API returns a match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(censusResponse(41.9403, -87.6860));
    const result = await client.geocodeAddress('2307 West Melrose Street, Chicago, IL 60618');
    expect(result).not.toBeNull();
    expect(result!.lat).toBeCloseTo(41.9403);
    expect(result!.lng).toBeCloseTo(-87.6860);
  });

  it('resolvePinFromCoordinates returns the closest PIN', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { pin: '14193280371001', latitude: '41.9403', longitude: '-87.6860' },
        { pin: '14193280150000', latitude: '41.9415', longitude: '-87.6875' },
      ]),
    } as Response);
    const result = await client.resolvePinFromCoordinates(41.9403, -87.6860);
    expect(result).toBe('14193280371001');
  });

  it('resolvePinFromCoordinates returns null when parcel dataset returns empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);
    const result = await client.resolvePinFromCoordinates(41.9403, -87.6860);
    expect(result).toBeNull();
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
