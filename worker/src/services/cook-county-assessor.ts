/**
 * Cook County Assessor Client
 *
 * Queries the Cook County Assessor's open data portal (Socrata SODA API)
 * for property characteristics including building square footage.
 *
 * Dataset: Single/Multi-Family Improvement Characteristics (bcnq-qi2z)
 * API: https://datacatalog.cookcountyil.gov/resource/bcnq-qi2z.json
 * No API key required for public datasets.
 *
 * PIN Resolution Pipeline (preferred path):
 *   1. Geocode address → lat/lng via US Census Geocoder (free, no key)
 *   2. Resolve PIN from lat/lng via Cook County Parcel Locations dataset (c49d-89sn)
 *   3. Query assessor by exact PIN — eliminates wrong-township collisions
 *
 * Fallback: if geocoding or PIN resolution fails, falls back to the original
 * address-string LIKE query against the assessor dataset.
 */

export interface AssessorPropertyRecord {
  pin: string;           // 14-digit Property Index Number
  address: string;       // Full property address
  buildingSqft: number;  // Building sqft (per-unit estimate when isSubUnit && divisor applied)
  propertyClass: string; // Property classification code
  township: string;      // Township code (town_code field)
  /**
   * True when the input address contained a sub-unit qualifier (APT, UNIT, #,
   * REAR, FRONT, COACH HOUSE, GARDEN, BASEMENT, etc.).
   * When true and unitCount > 1, buildingSqft is already divided by unitCount.
   * When true and unitCount <= 1, buildingSqft is the full building total.
   */
  isSubUnit: boolean;
  /** Number of apartment units from the assessor record (undefined if not present) */
  unitCount?: number;
  /**
   * The raw total building sqft from the assessor record, before any sub-unit
   * divisor was applied. Only set when isSubUnit is true and a divisor was
   * actually applied (i.e. buildingSqft < totalSqft).
   */
  totalSqft?: number;
  /**
   * True when the sub-unit qualifier was a structural secondary unit
   * (coach house, carriage house, rear, front, garden, basement).
   */
  structuralQualifier?: boolean;
}

/** Raw record shape returned by the SODA API */
interface SodaRecord {
  pin?: string;
  addr?: string;
  bldg_sf?: string;  // Total building sqft — present for single/multi-family (class 2xx)
  hd_sf?: string;    // Heated/habitable sqft — present for condos/co-ops (class 299, 3xx)
  apts?: string;     // Number of apartment units in the building
  class?: string;
  town_code?: string;
  tax_year?: string;
}

/** Raw record shape from the Cook County Parcel Locations dataset (c49d-89sn) */
interface ParcelLocationRecord {
  pin?: string;
  property_address?: string;
  latitude?: string;
  longitude?: string;
}

/** Raw response shape from the US Census Geocoder */
interface CensusGeocodeResponse {
  result?: {
    addressMatches?: Array<{
      coordinates?: {
        x?: number; // longitude
        y?: number; // latitude
      };
    }>;
  };
}

export class CookCountyAssessorClient {
  private static readonly BASE_URL = 'https://datacatalog.cookcountyil.gov/resource';
  private static readonly DATASET_ID = 'bcnq-qi2z';
  private static readonly PARCEL_DATASET_ID = 'c49d-89sn';
  private static readonly CENSUS_GEOCODER_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
  private static readonly TIMEOUT_MS = 10000;

  /**
   * Look up property characteristics by address.
   *
   * Preferred path: geocode → PIN → assessor query by exact PIN.
   * Fallback: address-string LIKE query (original behavior).
   *
   * Returns the most recent record with a valid building square footage.
   * Returns null if no matching property is found or on any error.
   */
  async lookupByAddress(address: string): Promise<AssessorPropertyRecord | null> {
    const parsed = this.parseAddress(address);
    if (!parsed) {
      return null;
    }

    // --- Preferred path: geocode → PIN → exact assessor lookup ---
    try {
      const coords = await this.geocodeAddress(address);
      if (coords) {
        const pin = await this.resolvePinFromCoordinates(coords.lat, coords.lng);
        if (pin) {
          const result = await this.lookupByPin(pin, parsed);
          if (result) {
            return result;
          }
          // PIN found but no assessor record with valid sqft — fall through
        }
      }
    } catch {
      // Geocode/PIN resolution failure — fall through to address-string query
    }

    // --- Fallback: address-string LIKE query ---
    return this.lookupByAddressString(parsed, address);
  }

  /**
   * Step 1: Geocode a street address to lat/lng using the US Census Geocoder.
   * Free, no API key required. Returns null on any failure.
   */
  async geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
    const params = new URLSearchParams({
      address,
      benchmark: '2020',
      format: 'json',
    });

    const url = `${CookCountyAssessorClient.CENSUS_GEOCODER_URL}?${params.toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as CensusGeocodeResponse;
      const match = data?.result?.addressMatches?.[0];
      if (!match?.coordinates?.x || !match?.coordinates?.y) {
        return null;
      }

      return { lat: match.coordinates.y, lng: match.coordinates.x };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Step 2: Resolve a Cook County PIN from lat/lng coordinates.
   *
   * Queries the Cook County Parcel Locations dataset (c49d-89sn) using a
   * bounding box around the coordinates, then picks the closest parcel centroid.
   * Returns null if no parcel is found within the search radius.
   */
  async resolvePinFromCoordinates(lat: number, lng: number): Promise<string | null> {
    // ~100m bounding box (0.001 degrees ≈ 111m at this latitude)
    const delta = 0.001;
    const whereClause = `latitude between ${lat - delta} and ${lat + delta} and longitude between ${lng - delta} and ${lng + delta}`;

    const params = new URLSearchParams({
      $where: whereClause,
      $select: 'pin,property_address,latitude,longitude',
      $limit: '10',
    });

    const url = `${CookCountyAssessorClient.BASE_URL}/${CookCountyAssessorClient.PARCEL_DATASET_ID}.json?${params.toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return null;
      }

      const records = (await response.json()) as ParcelLocationRecord[];
      if (!Array.isArray(records) || records.length === 0) {
        return null;
      }

      // Pick the parcel whose centroid is closest to the geocoded point
      let closestPin: string | null = null;
      let closestDist = Infinity;

      for (const record of records) {
        if (!record.pin || !record.latitude || !record.longitude) continue;
        const rLat = parseFloat(record.latitude);
        const rLng = parseFloat(record.longitude);
        if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) continue;
        const dist = Math.sqrt((rLat - lat) ** 2 + (rLng - lng) ** 2);
        if (dist < closestDist) {
          closestDist = dist;
          closestPin = record.pin;
        }
      }

      return closestPin;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Step 3: Query the assessor dataset by exact PIN.
   * Returns null if no record with valid sqft is found.
   */
  private async lookupByPin(
    pin: string,
    parsed: { houseNumber: string; street: string; isSubUnit: boolean; structuralQualifier: boolean },
  ): Promise<AssessorPropertyRecord | null> {
    const params = new URLSearchParams({
      pin,
      $select: 'pin,addr,bldg_sf,hd_sf,apts,class,town_code,tax_year',
      $order: 'tax_year DESC',
      $limit: '5',
    });

    const url = `${CookCountyAssessorClient.BASE_URL}/${CookCountyAssessorClient.DATASET_ID}.json?${params.toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CookCountyAssessorClient.TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        console.warn(
          `CookCountyAssessorClient: lookupByPin HTTP ${response.status} for pin "${pin}" (${parsed.houseNumber} ${parsed.street})`,
        );
        return null;
      }

      let records: SodaRecord[];
      try {
        records = (await response.json()) as SodaRecord[];
      } catch (parseErr) {
        console.warn(
          `CookCountyAssessorClient: lookupByPin failed to parse JSON for pin "${pin}": ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
        return null;
      }

      if (!Array.isArray(records)) {
        console.warn(
          `CookCountyAssessorClient: lookupByPin unexpected response shape for pin "${pin}" (${parsed.houseNumber} ${parsed.street})`,
        );
        return null;
      }

      const getSqft = (r: SodaRecord): number => {
        const bldg = r.bldg_sf !== undefined ? parseInt(r.bldg_sf, 10) : 0;
        const hd = r.hd_sf !== undefined ? parseInt(r.hd_sf, 10) : 0;
        return bldg > 0 ? bldg : hd;
      };

      const match = records.find((r) => getSqft(r) > 0);
      if (!match) {
        console.warn(
          `CookCountyAssessorClient: lookupByPin no sqft record found for pin "${pin}" (${parsed.houseNumber} ${parsed.street})`,
        );
        return null;
      }

      return this.buildRecord(match, parsed, pin);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Timeout — silently return null so the fallback runs
        return null;
      }
      console.warn(
        `CookCountyAssessorClient: lookupByPin network error for pin "${pin}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fallback: query the assessor dataset by address-string LIKE filter.
   * Original behavior — used when geocoding or PIN resolution fails.
   */
  private async lookupByAddressString(
    parsed: { houseNumber: string; street: string; isSubUnit: boolean; structuralQualifier: boolean },
    originalAddress: string,
  ): Promise<AssessorPropertyRecord | null> {
    const { houseNumber, street } = parsed;

    console.log(`[CookCountyAssessorClient] Querying assessor: "${houseNumber} ${street}"`);

    const escapedStreet = street.replace(/'/g, "''");
    const whereClause = `upper(addr) like '${houseNumber} ${escapedStreet}%'`;
    const params = new URLSearchParams({
      $where: whereClause,
      $select: 'pin,addr,bldg_sf,hd_sf,apts,class,town_code,tax_year',
      $order: 'tax_year DESC',
      $limit: '5',
    });

    const url = `${CookCountyAssessorClient.BASE_URL}/${CookCountyAssessorClient.DATASET_ID}.json?${params.toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CookCountyAssessorClient.TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        console.warn(
          `CookCountyAssessorClient: HTTP ${response.status} for address "${originalAddress}"`,
        );
        return null;
      }

      let records: SodaRecord[];
      try {
        records = (await response.json()) as SodaRecord[];
      } catch {
        console.warn(
          `CookCountyAssessorClient: Failed to parse JSON response for address "${originalAddress}"`,
        );
        return null;
      }

      if (!Array.isArray(records)) {
        console.warn(
          `CookCountyAssessorClient: Unexpected response shape for address "${originalAddress}"`,
        );
        return null;
      }

      const getSqft = (r: SodaRecord): number => {
        const bldg = r.bldg_sf !== undefined ? parseInt(r.bldg_sf, 10) : 0;
        const hd = r.hd_sf !== undefined ? parseInt(r.hd_sf, 10) : 0;
        return bldg > 0 ? bldg : hd;
      };

      const match = records.find((r) => getSqft(r) > 0);
      if (!match) {
        return null;
      }

      return this.buildRecord(match, parsed, match.pin ?? '');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return null;
      }
      console.warn(
        `CookCountyAssessorClient: Network error for address "${originalAddress}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Shared logic: build an AssessorPropertyRecord from a raw SODA record and
   * parsed address components. Returns null if sqft is zero or invalid.
   */
  private buildRecord(
    match: SodaRecord,
    parsed: { houseNumber: string; street: string; isSubUnit: boolean; structuralQualifier: boolean },
    pin: string,
  ): AssessorPropertyRecord | null {
    const getSqft = (r: SodaRecord): number => {
      const bldg = r.bldg_sf !== undefined ? parseInt(r.bldg_sf, 10) : 0;
      const hd = r.hd_sf !== undefined ? parseInt(r.hd_sf, 10) : 0;
      return bldg > 0 ? bldg : hd;
    };

    const totalSqft = getSqft(match);
    if (totalSqft <= 0) return null;

    const unitCount = match.apts !== undefined ? parseInt(match.apts, 10) : 0;
    const bldgSfParsed = parseInt(match.bldg_sf ?? '', 10);
    // hd_sf is a unit-level (heated/habitable) sqft field used for condos/co-ops.
    // When it was the source of totalSqft, the value is already per-unit — do not divide again.
    const usedUnitLevelField = match.bldg_sf === undefined || !Number.isFinite(bldgSfParsed) || bldgSfParsed <= 0;

    let buildingSqft: number;
    let divisorApplied = false;

    if (parsed.isSubUnit && !usedUnitLevelField) {
      // Only apply divisors when sqft came from bldg_sf (whole-building total)
      if (unitCount > 1) {
        buildingSqft = Math.round(totalSqft / unitCount);
        divisorApplied = true;
      } else if (parsed.structuralQualifier) {
        // Structural secondary unit (coach house, carriage house, rear, etc.) — assume ~1/3 of parcel
        buildingSqft = Math.round(totalSqft / 3);
        divisorApplied = true;
      } else {
        // Generic unit qualifier (APT, UNIT, #, etc.) with no unit count — assume duplex (1/2)
        buildingSqft = Math.round(totalSqft / 2);
        divisorApplied = true;
      }
    } else if (parsed.isSubUnit && usedUnitLevelField) {
      // sqft came from hd_sf (per-unit heated area) — the value IS already the unit sqft.
      // Back-calculate an estimated total building sqft using the same heuristics in reverse,
      // so the UI can show "X sq ft (est. unit) · Y sq ft est. total property".
      buildingSqft = totalSqft; // hd_sf is already the unit sqft — use as-is
      divisorApplied = true;    // flag so totalSqft is exposed on the record
    } else {
      // Not a sub-unit — buildingSqft IS the total
      buildingSqft = totalSqft;
    }

    // When back-calculating from hd_sf, compute the estimated total using the same
    // multipliers as the forward divisor path.
    const estimatedTotal: number | undefined = (() => {
      if (!divisorApplied) return undefined;
      if (!usedUnitLevelField) return totalSqft; // bldg_sf path — totalSqft is the real total
      // hd_sf path — reverse the heuristic to estimate the building total
      if (unitCount > 1) return Math.round(totalSqft * unitCount);
      if (parsed.structuralQualifier) return Math.round(totalSqft * 3);
      return Math.round(totalSqft * 2);
    })();

    return {
      pin: match.pin ?? pin,
      address: match.addr ?? '',
      buildingSqft,
      propertyClass: match.class ?? '',
      township: match.town_code ?? '',
      isSubUnit: parsed.isSubUnit,
      unitCount: unitCount > 0 ? unitCount : undefined,
      // Only expose totalSqft when a divisor was applied — otherwise buildingSqft IS the total
      totalSqft: estimatedTotal,
      structuralQualifier: parsed.structuralQualifier || undefined,
    };
  }

  /**
   * USPS directional abbreviation map.
   */
  private static readonly DIRECTION_MAP: Record<string, string> = {
    NORTH: 'N',
    SOUTH: 'S',
    EAST: 'E',
    WEST: 'W',
    NORTHEAST: 'NE',
    NORTHWEST: 'NW',
    SOUTHEAST: 'SE',
    SOUTHWEST: 'SW',
  };

  /**
   * USPS street-type abbreviation map.
   */
  private static readonly STREET_TYPE_MAP: Record<string, string> = {
    STREET: 'ST',
    AVENUE: 'AVE',
    BOULEVARD: 'BLVD',
    DRIVE: 'DR',
    LANE: 'LN',
    ROAD: 'RD',
    COURT: 'CT',
    PLACE: 'PL',
    TERRACE: 'TER',
    CIRCLE: 'CIR',
    TRAIL: 'TRL',
    PARKWAY: 'PKWY',
    HIGHWAY: 'HWY',
    EXPRESSWAY: 'EXPY',
    FREEWAY: 'FWY',
  };

  /**
   * Normalize a street string to match Cook County Assessor USPS abbreviations.
   */
  private normalizeStreetForAssessor(street: string): string {
    const tokens = street.trim().split(/\s+/);
    if (tokens.length === 0) return street;

    const normalize = (token: string) => token.replace(/\.+$/, '').toUpperCase();

    const firstNorm = normalize(tokens[0]);
    if (CookCountyAssessorClient.DIRECTION_MAP[firstNorm]) {
      tokens[0] = CookCountyAssessorClient.DIRECTION_MAP[firstNorm];
    }

    const lastNorm = normalize(tokens[tokens.length - 1]);
    if (CookCountyAssessorClient.STREET_TYPE_MAP[lastNorm]) {
      tokens[tokens.length - 1] = CookCountyAssessorClient.STREET_TYPE_MAP[lastNorm];
    }

    return tokens.join(' ');
  }

  /**
   * Parse a street address into components suitable for a SODA query.
   *
   * Extracts the house number and street name (normalized to uppercase and
   * converted to USPS abbreviations to match Cook County Assessor records).
   * Strips city/state/zip suffixes and apartment/unit/suite designators.
   * Returns null for PO Boxes or addresses with no extractable house number.
   *
   * Also detects sub-unit qualifiers (APT, UNIT, REAR, COACH HOUSE, etc.) and
   * returns isSubUnit=true so callers can warn that the sqft is for the full
   * building, not the specific unit.
   */
  private parseAddress(address: string): { houseNumber: string; street: string; isSubUnit: boolean; structuralQualifier: boolean } | null {
    const upper = address.trim().toUpperCase();

    if (/^P\.?O\.?\s*BOX\b/i.test(upper)) {
      return null;
    }

    const houseMatch = upper.match(/^(\d+[A-Z]?)\s+(.+)$/);
    if (!houseMatch) {
      return null;
    }

    const houseNumber = houseMatch[1];
    let remainder = houseMatch[2];

    // Detect sub-unit qualifiers BEFORE stripping them, so we can flag the result.
    // IMPORTANT: test only `remainder` (the part after the house number), NOT the full address,
    // to avoid false positives from street names like "Front Street" or "Garden Avenue".
    const subUnitPattern = /\b(APT|APARTMENT|UNIT|SUITE|STE|FL|FLOOR|NO\.?|REAR|FRONT|GARDEN|BASEMENT|COACH\s+HOUSE|CARRIAGE\s+HOUSE)\b|#\s*[\w-]+/i;
    const isSubUnit = subUnitPattern.test(remainder);

    const structuralQualifierPattern = /\b(REAR|FRONT|GARDEN|BASEMENT|COACH\s+HOUSE|CARRIAGE\s+HOUSE)\b/i;
    const structuralQualifier = structuralQualifierPattern.test(remainder);

    // Strip trailing comma-separated city/state/zip
    remainder = remainder.replace(/,.*$/, '').trim();

    // Strip unit/apartment/suite suffixes
    remainder = remainder
      .replace(/\s+(APT|APARTMENT|UNIT|SUITE|STE|FL|FLOOR|NO\.?)\s*[\w-]+.*$/i, '')
      .replace(/\s+#\s*[\w-]+.*$/i, '')
      .trim();

    // Strip trailing state abbreviation + optional zip
    remainder = remainder.replace(/\s+[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/, '').trim();
    remainder = remainder.replace(/\s+\d{5}(-\d{4})?$/, '').trim();

    // Strip trailing city name by truncating after the last recognized street-type token
    const streetTypeSuffixes = new Set([
      'STREET', 'ST', 'AVENUE', 'AVE', 'BOULEVARD', 'BLVD', 'DRIVE', 'DR',
      'LANE', 'LN', 'ROAD', 'RD', 'COURT', 'CT', 'PLACE', 'PL', 'WAY',
      'TERRACE', 'TER', 'CIRCLE', 'CIR', 'TRAIL', 'TRL', 'PARKWAY', 'PKWY',
      'HIGHWAY', 'HWY', 'EXPRESSWAY', 'EXPY', 'FREEWAY', 'FWY',
    ]);

    const tokens = remainder.split(/\s+/);
    let lastStreetTypeIdx = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (streetTypeSuffixes.has(tokens[i])) {
        lastStreetTypeIdx = i;
        break;
      }
    }

    let street: string;
    if (lastStreetTypeIdx >= 0) {
      street = tokens.slice(0, lastStreetTypeIdx + 1).join(' ');
    } else {
      street = remainder;
    }

    if (!street) {
      return null;
    }

    street = this.normalizeStreetForAssessor(street);

    return { houseNumber, street, isSubUnit, structuralQualifier };
  }
}
