import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqftResolutionService } from '../../worker/src/services/sqft-resolution-service.js';
import type { ResolutionMetadata } from 'shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal R2Bucket mock — only `get` is used by the vision tier */
function makeR2Bucket(): R2Bucket {
  return {
    get: vi.fn().mockResolvedValue(null),
  } as unknown as R2Bucket;
}

/** Mock fetch to return a Cook County Assessor SODA response */
function mockAssessorFetch(records: object[]) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => records,
  } as Response);
}

// ---------------------------------------------------------------------------
// Tier 3 — public records metadata passthrough
//
// These tests exist to catch regressions where fields computed in the assessor
// client (totalSqft, structuralQualifier) are not forwarded into
// ResolutionMetadata, causing the UI to be unable to show both sqft values.
// ---------------------------------------------------------------------------

describe('SqftResolutionService — Tier 3 public records metadata passthrough', () => {
  let service: SqftResolutionService;

  beforeEach(() => {
    service = new SqftResolutionService('test-key', 'https://api.openai.com/v1', makeR2Bucket());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets totalPropertySqft and structuralQualifier=true in metadata for a coach house address', async () => {
    mockAssessorFetch([
      { pin: '14-19-328-037-1001', addr: '2307 W MELROSE ST', bldg_sf: '9375', class: '211', town_code: '77', tax_year: '2023' },
    ]);

    const result = await service.resolve({
      customerText: 'Coach house renovation',
      mediaItemIds: [],
      jobberImageUrls: [],
      jobberPropertyAddress: '2307 W Melrose St Rear Coach House, Chicago, IL 60618',
    });

    expect(result.resolved).toBe(true);
    expect(result.tier).toBe('public_records');
    expect(result.value).toBe(Math.round(9375 / 3)); // ÷3 structural heuristic

    const meta = result.metadata as ResolutionMetadata;
    expect(meta.isSubUnit).toBe(true);
    expect(meta.structuralQualifier).toBe(true);
    // This is the critical assertion — totalPropertySqft must be present so the
    // UI can show "X sq ft (est. coach house) · Y sq ft total property"
    expect(meta.totalPropertySqft).toBe(9375);
  });

  it('sets totalPropertySqft and structuralQualifier=false in metadata for a generic APT address', async () => {
    mockAssessorFetch([
      { pin: '14-19-328-037-1001', addr: '2307 W MELROSE ST', bldg_sf: '4000', class: '211', town_code: '77', tax_year: '2023' },
    ]);

    const result = await service.resolve({
      customerText: 'Apartment renovation',
      mediaItemIds: [],
      jobberImageUrls: [],
      jobberPropertyAddress: '2307 W Melrose St Apt 2, Chicago, IL 60618',
    });

    expect(result.resolved).toBe(true);
    expect(result.value).toBe(Math.round(4000 / 2)); // ÷2 generic heuristic

    const meta = result.metadata as ResolutionMetadata;
    expect(meta.isSubUnit).toBe(true);
    expect(meta.structuralQualifier).toBeFalsy();
    expect(meta.totalPropertySqft).toBe(4000);
  });

  it('sets totalPropertySqft when divided by known unit count', async () => {
    mockAssessorFetch([
      { pin: '14-19-328-037-1001', addr: '2307 W MELROSE ST', bldg_sf: '6000', apts: '3', class: '212', town_code: '77', tax_year: '2023' },
    ]);

    const result = await service.resolve({
      customerText: 'Unit renovation',
      mediaItemIds: [],
      jobberImageUrls: [],
      jobberPropertyAddress: '2307 W Melrose St Unit 2, Chicago, IL 60618',
    });

    expect(result.resolved).toBe(true);
    expect(result.value).toBe(2000); // 6000 / 3

    const meta = result.metadata as ResolutionMetadata;
    expect(meta.totalPropertySqft).toBe(6000);
    expect(meta.unitCount).toBe(3);
  });

  it('does NOT set totalPropertySqft for a plain address with no sub-unit qualifier', async () => {
    mockAssessorFetch([
      { pin: '14-19-328-037-1001', addr: '2307 W MELROSE ST', bldg_sf: '3125', class: '211', town_code: '77', tax_year: '2023' },
    ]);

    const result = await service.resolve({
      customerText: 'Full house renovation',
      mediaItemIds: [],
      jobberImageUrls: [],
      jobberPropertyAddress: '2307 W Melrose St, Chicago, IL 60618',
    });

    expect(result.resolved).toBe(true);
    expect(result.value).toBe(3125);

    const meta = result.metadata as ResolutionMetadata;
    expect(meta.isSubUnit).toBeFalsy();
    expect(meta.totalPropertySqft).toBeUndefined(); // no divisor applied
  });
});

// ---------------------------------------------------------------------------
// Tier 1 — text extraction (smoke test to confirm tier priority)
// ---------------------------------------------------------------------------

describe('SqftResolutionService — Tier 1 text extraction', () => {
  let service: SqftResolutionService;

  beforeEach(() => {
    service = new SqftResolutionService('test-key', 'https://api.openai.com/v1', makeR2Bucket());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts sqft from customer text and does not call the assessor API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await service.resolve({
      customerText: 'We need to paint the living room, about 1500 sqft total.',
      mediaItemIds: [],
      jobberImageUrls: [],
      jobberPropertyAddress: '2307 W Melrose St, Chicago, IL 60618',
    });

    expect(result.resolved).toBe(true);
    expect(result.tier).toBe('text_extraction');
    expect(result.value).toBe(1500);
    // Tier 1 short-circuits — assessor API must NOT be called
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
