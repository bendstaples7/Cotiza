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
  buildingSqft: number;  // Total building square footage
  propertyClass: string; // Property classification code
  township: string;      // Township code (town_code field)
}

/** Raw record shape returned by the SODA API */
interface SodaRecord {
  pin?: string;
  addr?: string;
  bldg_sf?: string;
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

    // Escape single quotes in street name to prevent SoQL injection
    // (e.g., "O'BRIEN ST" → "O''BRIEN ST" in SoQL string literals)
    const escapedStreet = street.replace(/'/g, "''");

    // Build SODA query — filter by address prefix, order by most recent tax year first
    const whereClause = `upper(addr) like '${houseNumber} ${escapedStreet}%'`;
    const params = new URLSearchParams({
      $where: whereClause,
      $select: 'pin,addr,bldg_sf,class,town_code,tax_year',
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

      // Find the first record with a valid bldg_sf > 0
      const match = records.find(
        (r) => r.bldg_sf !== undefined && r.bldg_sf !== null && parseInt(r.bldg_sf, 10) > 0,
      );

      if (!match) {
        return null;
      }

      return {
        pin: match.pin ?? '',
        address: match.addr ?? address,
        buildingSqft: parseInt(match.bldg_sf!, 10),
        propertyClass: match.class ?? '',
        township: match.town_code ?? '',
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
   * Parse a street address into components suitable for a SODA query.
   *
   * Extracts the house number and street name (normalized to uppercase).
   * Strips city/state/zip suffixes and apartment/unit/suite designators.
   * Returns null for PO Boxes or addresses with no extractable house number.
   *
   * Examples:
   *   "123 N Main St, Chicago, IL 60601" → { houseNumber: "123", street: "N MAIN ST" }
   *   "456 Oak Avenue Apt 2B"            → { houseNumber: "456", street: "OAK AVENUE" }
   *   "PO Box 123"                       → null
   *   "No number here"                   → null
   */
  private parseAddress(address: string): { houseNumber: string; street: string } | null {
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

    return { houseNumber, street };
  }
}
