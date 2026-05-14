import type { SpaceContext } from 'shared';
import { resolveSpaceAllocation } from './space-allocation-service.js';

/** Raw entry returned by the AI extraction call */
interface RawSpaceEntry {
  spaceName: string;
  sqft: number | null;
}

/**
 * Service that extracts room/space information from customer request text using GPT-4o-mini.
 * Never throws — any failure returns an empty array so quote generation continues unaffected.
 */
export class SpaceExtractionService {
  private readonly apiKey: string;
  private readonly apiUrl: string;

  constructor(apiKey: string, apiUrl: string) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  /**
   * Extract spaces mentioned in the customer text and resolve sqft context for each.
   *
   * @param customerText  The raw customer request text.
   * @param totalSqft     Whole-property sqft (used for allocation estimates), or null if unknown.
   * @returns             Array of SpaceContext entries, or [] on any failure.
   */
  async extractSpaces(customerText: string, totalSqft: number | null): Promise<SpaceContext[]> {
    if (!this.apiKey || !customerText.trim()) {
      return [];
    }

    try {
      const rawEntries = await this.callAI(customerText);
      return rawEntries.map((entry) => this.buildSpaceContext(entry, totalSqft));
    } catch (err) {
      console.warn(
        `SpaceExtractionService: extraction failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Call GPT-4o-mini and return the parsed raw entries. Throws on any failure. */
  private async callAI(customerText: string): Promise<RawSpaceEntry[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.apiKey,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'Extract room/space information from home renovation requests. ' +
                'Return JSON array: [{ spaceName: string, sqft: number | null }]. ' +
                'Return [] if no spaces mentioned. Return ONLY valid JSON.',
            },
            {
              role: 'user',
              content: customerText,
            },
          ],
          temperature: 0.1,
          max_tokens: 300,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`OpenAI API returned ${response.status}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('SpaceExtractionService: invalid JSON from AI');
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`SpaceExtractionService: expected JSON array, got: ${typeof parsed}`);
    }

    // Filter to entries that at least have a non-empty spaceName string
    return (parsed as RawSpaceEntry[]).filter(
      (e) => e && typeof e.spaceName === 'string' && e.spaceName.trim().length > 0,
    );
  }

  /** Build a SpaceContext from a raw AI entry and the whole-property sqft. */
  private buildSpaceContext(entry: RawSpaceEntry, totalSqft: number | null): SpaceContext {
    const explicitSqft =
      typeof entry.sqft === 'number' && Number.isFinite(entry.sqft) && entry.sqft > 0
        ? entry.sqft
        : null;

    const sqftIsExplicit = explicitSqft !== null;

    const trimmedName = entry.spaceName.trim();

    // Only attempt allocation estimate when we have a whole-property sqft and no explicit value
    const allocation =
      !sqftIsExplicit && totalSqft !== null
        ? resolveSpaceAllocation(trimmedName, totalSqft)
        : null;

    return {
      spaceName: trimmedName,
      normalizedLabel: allocation?.normalizedLabel ?? trimmedName,
      explicitSqft,
      estimatedSqft: allocation?.estimatedSqft ?? null,
      sqftIsExplicit,
      allocationFraction: allocation?.fraction ?? null,
    };
  }
}
