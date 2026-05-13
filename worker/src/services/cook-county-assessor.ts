/**
 * Cook County Assessor Client
 *
 * Queries the Cook County Assessor's open data portal (Socrata SODA API)
 * for property characteristics including building square footage.
 *
 * Dataset: Single/Multi-Family Improvement Characteristics (bcnq-qi2z)
 * API: https://datacatalog.cookcountyil.gov/resource/bcnq-qi2z.json
 * No API key required for public datasets.
 */

export interface AssessorPropertyRecord {
  pin: string;           // 14-digit Property Index Number
  address: string;       // Full property address
  buildingSqft: number;  // Building sqft (per-unit estimate when isSubUnit && unitCount > 1)
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

export class CookCountyAssessorClient {
  private static readonly BASE_URL = 'https://datacatalog.cookcountyil.gov/resource';
  private static readonly DATASET_ID = 'bcnq-qi2z';
  private static readonly TIMEOUT_MS = 8000;

  /**
   * Look up property characteristics by address.
   *
   * Uses the Socrata SODA API with a SoQL LIKE filter on the `addr` field.
   * Returns the most recent record with a valid building square footage.
   * Returns null if no matching property is found or on any error.
   */
  async lookupByAddress(address: string): Promise<AssessorPropertyRecord | null> {
    const parsed = this.parseAddress(address);
    if (!parsed) {
      return null;
    }

    const { houseNumber, street } = parsed;

    // Log only the normalized query — not the raw address — to avoid writing PII to logs
    console.log(`[CookCountyAssessorClient] Querying assessor: "${houseNumber} ${street}"`);

    // Escape single quotes in street name to prevent SoQL injection
    // (e.g., "O'BRIEN ST" → "O''BRIEN ST" in SoQL string literals)
    const escapedStreet = street.replace(/'/g, "''");

    // Build SODA query — filter by address prefix, order by most recent tax year first
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
          `CookCountyAssessorClient: HTTP ${response.status} for address "${address}"`,
        );
        return null;
      }

      let records: SodaRecord[];
      try {
        records = (await response.json()) as SodaRecord[];
      } catch {
        console.warn(
          `CookCountyAssessorClient: Failed to parse JSON response for address "${address}"`,
        );
        return null;
      }

      if (!Array.isArray(records)) {
        console.warn(
          `CookCountyAssessorClient: Unexpected response shape for address "${address}"`,
        );
        return null;
      }

      // Find the first record with a valid sqft value.
      // bldg_sf = total building sqft (single/multi-family, class 2xx)
      // hd_sf   = heated/habitable sqft (condos/co-ops, class 299/3xx) — bldg_sf absent for these
      const getSqft = (r: SodaRecord): number => {
        const bldg = r.bldg_sf !== undefined ? parseInt(r.bldg_sf, 10) : 0;
        const hd = r.hd_sf !== undefined ? parseInt(r.hd_sf, 10) : 0;
        return bldg > 0 ? bldg : hd;
      };

      const match = records.find((r) => getSqft(r) > 0);

      if (!match) {
        return null;
      }

      const totalSqft = getSqft(match);
      const unitCount = match.apts !== undefined ? parseInt(match.apts, 10) : 0;
      // hd_sf is a unit-level (heated/habitable) sqft field used for condos/co-ops.
      // When it was the source of totalSqft, the value is already per-unit — do not divide again.
      const usedUnitLevelField = match.bldg_sf === undefined || parseInt(match.bldg_sf ?? '0', 10) === 0;

      // Determine the effective sqft for this specific unit/sub-structure.
      let buildingSqft: number;
      if (parsed.isSubUnit && !usedUnitLevelField) {
        // Only apply divisors when sqft came from bldg_sf (whole-building total)
        if (unitCount > 1) {
          // Assessor record has unit count — divide evenly
          buildingSqft = Math.round(totalSqft / unitCount);
        } else if (parsed.structuralQualifier) {
          // Structural secondary unit (coach house, carriage house, rear, etc.) — assume ~1/3 of parcel
          buildingSqft = Math.round(totalSqft / 3);
        } else {
          // Generic unit qualifier (APT, UNIT, #, etc.) with no unit count — assume duplex (1/2)
          buildingSqft = Math.round(totalSqft / 2);
        }
      } else {
        // Either not a sub-unit, or sqft already came from a unit-level field (hd_sf)
        buildingSqft = totalSqft;
      }

      return {
        pin: match.pin ?? '',
        address: match.addr ?? address,
        buildingSqft,
        propertyClass: match.class ?? '',
        township: match.town_code ?? '',
        isSubUnit: parsed.isSubUnit,
        unitCount: unitCount > 0 ? unitCount : undefined,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Timeout — silently return null (expected failure mode)
        return null;
      }
      console.warn(
        `CookCountyAssessorClient: Network error for address "${address}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * USPS directional abbreviation map.
   * Cook County Assessor stores directions as single-letter abbreviations.
   * Jobber returns full words (e.g. "SOUTH HYDE PARK BOULEVARD").
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
   * Cook County Assessor stores types as abbreviations (BLVD, AVE, ST, etc.).
   * Jobber returns full words (BOULEVARD, AVENUE, STREET, etc.).
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
   *
   * - Converts leading directional words to abbreviations (SOUTH → S, NORTH → N, etc.)
   * - Converts trailing street-type words to abbreviations (BOULEVARD → BLVD, etc.)
   *
   * Examples:
   *   "SOUTH HYDE PARK BOULEVARD" → "S HYDE PARK BLVD"
   *   "NORTH MICHIGAN AVENUE"     → "N MICHIGAN AVE"
   *   "WEST MADISON STREET"       → "W MADISON ST"
   *   "N MAIN ST"                 → "N MAIN ST"  (already abbreviated — unchanged)
   */
  private normalizeStreetForAssessor(street: string): string {
    const tokens = street.trim().split(/\s+/);
    if (tokens.length === 0) return street;

    // Strip trailing dots and normalize case before map lookup
    // so dotted abbreviations like "N." → "N" and "ST." → "ST" are recognized
    const normalize = (token: string) => token.replace(/\.+$/, '').toUpperCase();

    // Normalize leading directional word (first token only)
    const firstNorm = normalize(tokens[0]);
    if (CookCountyAssessorClient.DIRECTION_MAP[firstNorm]) {
      tokens[0] = CookCountyAssessorClient.DIRECTION_MAP[firstNorm];
    }

    // Normalize trailing street-type word (last token only)
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
   *
   * Examples:
   *   "123 N Main St, Chicago, IL 60601"       → { houseNumber: "123", street: "N MAIN ST", isSubUnit: false }
   *   "456 South Oak Avenue Apt 2B"             → { houseNumber: "456", street: "S OAK AVE", isSubUnit: true }
   *   "5465 South Hyde Park Boulevard, Chicago" → { houseNumber: "5465", street: "S HYDE PARK BLVD", isSubUnit: false }
   *   "5465 S Hyde Park Blvd Rear Coach House"  → { houseNumber: "5465", street: "S HYDE PARK BLVD", isSubUnit: true }
   *   "PO Box 123"                              → null
   *   "No number here"                          → null
   */
  private parseAddress(address: string): { houseNumber: string; street: string; isSubUnit: boolean; structuralQualifier: boolean } | null {
    const upper = address.trim().toUpperCase();

    // Reject PO Boxes
    if (/^P\.?O\.?\s*BOX\b/i.test(upper)) {
      return null;
    }

    // Must start with a house number (digits, optionally followed by a letter like "123A")
    const houseMatch = upper.match(/^(\d+[A-Z]?)\s+(.+)$/);
    if (!houseMatch) {
      return null;
    }

    const houseNumber = houseMatch[1];
    let remainder = houseMatch[2];

    // Detect sub-unit qualifiers BEFORE stripping them, so we can flag the result.
    // Covers: APT, APARTMENT, UNIT, SUITE, STE, FL, FLOOR, NO., #
    // and structural qualifiers: REAR, FRONT, GARDEN, BASEMENT, COACH HOUSE, CARRIAGE HOUSE
    //
    // IMPORTANT: test only `remainder` (the part after the house number), NOT the full address,
    // to avoid false positives from street names like "Front Street" or "Garden Avenue".
    const subUnitPattern = /\b(APT|APARTMENT|UNIT|SUITE|STE|FL|FLOOR|NO\.?|REAR|FRONT|GARDEN|BASEMENT|COACH\s+HOUSE|CARRIAGE\s+HOUSE)\b|#\s*[\w-]+/i;
    const isSubUnit = subUnitPattern.test(remainder);

    // Detect structural secondary-unit qualifiers specifically (for the 1/3 heuristic).
    // These must appear as standalone words in the qualifier portion, not as part of the street name.
    // We test `remainder` before city/state stripping so the qualifier is still present.
    const structuralQualifierPattern = /\b(REAR|FRONT|GARDEN|BASEMENT|COACH\s+HOUSE|CARRIAGE\s+HOUSE)\b/i;
    const structuralQualifier = structuralQualifierPattern.test(remainder);

    // Strip trailing comma-separated city/state/zip:
    //   "N MAIN ST, CHICAGO, IL 60601" → "N MAIN ST"
    remainder = remainder.replace(/,.*$/, '').trim();

    // Strip unit/apartment/suite suffixes
    // Patterns: APT, UNIT, SUITE, STE, #, NO., FL (floor)
    remainder = remainder
      .replace(/\s+(APT|APARTMENT|UNIT|SUITE|STE|FL|FLOOR|NO\.?)\s*[\w-]+.*$/i, '')
      .replace(/\s+#\s*[\w-]+.*$/i, '')
      .trim();

    // Strip trailing state abbreviation + optional zip: "IL 60601" or "IL"
    remainder = remainder.replace(/\s+[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/, '').trim();

    // Strip trailing 5-digit zip if still present
    remainder = remainder.replace(/\s+\d{5}(-\d{4})?$/, '').trim();

    // Strip trailing city name by truncating after the last recognized street-type token.
    // Cook County addr values look like "123 N MAIN ST BARRINGTON" — no comma before city.
    // Include both full words and abbreviations so we can find the boundary before normalizing.
    const streetTypeSuffixes = new Set([
      'STREET', 'ST',
      'AVENUE', 'AVE',
      'BOULEVARD', 'BLVD',
      'DRIVE', 'DR',
      'LANE', 'LN',
      'ROAD', 'RD',
      'COURT', 'CT',
      'PLACE', 'PL',
      'WAY',
      'TERRACE', 'TER',
      'CIRCLE', 'CIR',
      'TRAIL', 'TRL',
      'PARKWAY', 'PKWY',
      'HIGHWAY', 'HWY',
      'EXPRESSWAY', 'EXPY',
      'FREEWAY', 'FWY',
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
      // Keep everything up to and including the street type token
      street = tokens.slice(0, lastStreetTypeIdx + 1).join(' ');
    } else {
      // No recognized street type — use the full remainder as-is
      street = remainder;
    }

    if (!street) {
      return null;
    }

    // Normalize to USPS abbreviations so the LIKE query matches Cook County records
    street = this.normalizeStreetForAssessor(street);

    return { houseNumber, street, isSubUnit, structuralQualifier };
  }
}
