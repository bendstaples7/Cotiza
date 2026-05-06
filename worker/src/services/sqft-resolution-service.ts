/**
 * Square Footage Resolution Service
 *
 * Implements a tiered pipeline for resolving property square footage:
 *   Tier 1 (high confidence)   — Text extraction from customer request text
 *   Tier 2 (medium confidence) — AI vision analysis of attached layout diagrams
 *   Tier 3 (low confidence)    — Cook County Assessor public records lookup
 *
 * The service never throws — all errors result in graceful fallthrough or a
 * "not_resolved" result so that quote generation is never blocked.
 */

import { CookCountyAssessorClient } from './cook-county-assessor.js';

// ---------------------------------------------------------------------------
// Types (mirrored in shared/src/types/quote.ts for client consumption)
// ---------------------------------------------------------------------------

export type ResolutionTier = 'text_extraction' | 'layout_diagram' | 'public_records' | 'manual_override';
export type ResolutionConfidence = 'high' | 'medium' | 'low';

export interface ResolutionMetadata {
  matchedText?: string;       // Tier 1: the matched text segment
  imageId?: string;           // Tier 2: which image was analyzed
  aiReasoning?: string;       // Tier 2: AI explanation
  propertyAddress?: string;   // Tier 3: address used for lookup
  assessorRecordId?: string;  // Tier 3: Cook County record identifier (PIN)
}

export interface ResolutionResult {
  resolved: boolean;
  value: number | null;
  tier: ResolutionTier | null;
  confidence: ResolutionConfidence | null;
  metadata: ResolutionMetadata;
}

export interface SqftResolutionResult {
  resolution: ResolutionResult;
  manualOverride: number | null;
  /** Preserved when a manual override is applied so the original can be restored */
  originalResolution: ResolutionResult | null;
}

// ---------------------------------------------------------------------------
// Address Resolution Helper
// ---------------------------------------------------------------------------

export interface AddressResolutionInput {
  /** Structured property address from the Jobber client record */
  jobberPropertyAddress?: string | null;
  /** Customer address from a manual request */
  manualRequestAddress?: string | null;
  /** Raw customer request text — used as a last-resort fallback */
  customerText?: string;
}

/**
 * Resolve a property address from available sources in priority order:
 *   1. Jobber client property address (most reliable — structured data)
 *   2. Manual request customer address
 *   3. Street address extracted from customer request text (fallback)
 *
 * Returns null if no address can be determined from any source.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */
export function resolvePropertyAddress(input: AddressResolutionInput): string | null {
  // Priority 1: Jobber property address
  if (input.jobberPropertyAddress && input.jobberPropertyAddress.trim().length > 0) {
    return input.jobberPropertyAddress.trim();
  }

  // Priority 2: Manual request customer address
  if (input.manualRequestAddress && input.manualRequestAddress.trim().length > 0) {
    return input.manualRequestAddress.trim();
  }

  // Priority 3: Extract a street address from free-form customer text
  if (input.customerText && input.customerText.trim().length > 0) {
    const extracted = extractAddressFromText(input.customerText);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

/**
 * Attempt to extract a US street address from free-form text.
 *
 * Matches patterns like:
 *   "123 N Main St"
 *   "456 Oak Avenue, Chicago, IL 60601"
 *   "789 W Elm Blvd Apt 3"
 *
 * Returns the first match found, or null if no recognizable address is present.
 */
function extractAddressFromText(text: string): string | null {
  // Pattern: house number + optional direction + street name + street type
  // Optionally followed by city/state/zip or unit designators
  const streetAddressPattern =
    /\b(\d{1,5}[A-Za-z]?\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Road|Rd|Court|Ct|Place|Pl|Way|Terrace|Ter|Circle|Cir|Trail|Trl|Parkway|Pkwy|Highway|Hwy)(?:\s*,?\s*[A-Za-z\s]+,?\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)?)\b/i;

  const match = text.match(streetAddressPattern);
  if (!match) {
    return null;
  }

  return match[1].trim();
}

// ---------------------------------------------------------------------------
// Resolution Context
// ---------------------------------------------------------------------------

export interface ResolutionContext {
  customerText: string;
  mediaItemIds: string[];
  jobberPropertyAddress?: string | null;
  manualRequestAddress?: string | null;
}

// ---------------------------------------------------------------------------
// SqftResolutionService
// ---------------------------------------------------------------------------

/**
 * Sqft regex pattern — reused from extraction-presets.ts for consistency.
 * Matches: "1500 sqft", "1,500 sq ft", "1500 square feet", "1500sf"
 */
const SQFT_PATTERN = /([\d][\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|square\s*feet|sf)\b/i;

export class SqftResolutionService {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly r2Bucket: R2Bucket;
  private readonly assessorClient: CookCountyAssessorClient;

  constructor(apiKey: string, apiUrl: string, r2Bucket: R2Bucket) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.r2Bucket = r2Bucket;
    this.assessorClient = new CookCountyAssessorClient();
  }

  /**
   * Resolve square footage through the tiered pipeline.
   * Stops at the first tier that produces a value.
   * Never throws — all errors result in graceful fallthrough.
   */
  async resolve(context: ResolutionContext): Promise<ResolutionResult> {
    // Tier 1: Text extraction
    const textResult = this.extractFromText(context.customerText);
    if (textResult) {
      return textResult;
    }

    // Tier 2: Layout diagram analysis (AI vision)
    if (context.mediaItemIds.length > 0) {
      try {
        const visionResult = await this.analyzeLayoutDiagrams(context.mediaItemIds);
        if (visionResult) {
          return visionResult;
        }
      } catch (err) {
        console.warn(
          `SqftResolutionService: Tier 2 (vision) failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Tier 3: Public records lookup
    const address = resolvePropertyAddress({
      jobberPropertyAddress: context.jobberPropertyAddress,
      manualRequestAddress: context.manualRequestAddress,
      customerText: context.customerText,
    });

    if (address) {
      try {
        const recordsResult = await this.lookupPublicRecords(address);
        if (recordsResult) {
          return recordsResult;
        }
      } catch (err) {
        console.warn(
          `SqftResolutionService: Tier 3 (public records) failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // No tier produced a value
    return {
      resolved: false,
      value: null,
      tier: null,
      confidence: null,
      metadata: {},
    };
  }

  /**
   * Tier 1: Extract square footage from customer request text.
   * Returns null if no match is found.
   */
  extractFromText(text: string): ResolutionResult | null {
    if (!text || text.trim().length === 0) {
      return null;
    }

    let match: RegExpExecArray | null;
    try {
      match = SQFT_PATTERN.exec(text);
    } catch {
      console.warn('SqftResolutionService: Tier 1 regex execution error');
      return null;
    }

    if (!match) {
      return null;
    }

    // Strip commas from the numeric string before parsing
    const numericString = match[1].replace(/,/g, '');
    const value = parseFloat(numericString);

    if (isNaN(value) || value <= 0) {
      return null;
    }

    return {
      resolved: true,
      value,
      tier: 'text_extraction',
      confidence: 'high',
      metadata: {
        matchedText: match[0],
      },
    };
  }

  /**
   * Tier 2: Analyze attached images for floor plans via AI vision.
   * Returns null if no floor plan is detected or on any error.
   */
  private async analyzeLayoutDiagrams(mediaItemIds: string[]): Promise<ResolutionResult | null> {
    for (const imageId of mediaItemIds) {
      try {
        // Fetch image from R2
        const object = await this.r2Bucket.get(imageId);
        if (!object) {
          continue;
        }

        const imageData = await object.arrayBuffer();
        // Convert to base64 in chunks to avoid stack overflow for large images
        // (spreading large Uint8Array into String.fromCharCode can exceed call stack)
        const bytes = new Uint8Array(imageData);
        const CHUNK_SIZE = 8192;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
        }
        const base64 = btoa(binary);
        const contentType = object.httpMetadata?.contentType ?? 'image/jpeg';

        // Send to OpenAI vision API
        const response = await fetch(`${this.apiUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Does this image show a floor plan, blueprint, or spatial layout diagram? If yes, estimate the total square footage depicted. Respond in JSON: { "isFloorPlan": boolean, "estimatedSqft": number | null, "reasoning": string }',
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${contentType};base64,${base64}`,
                    },
                  },
                ],
              },
            ],
            max_tokens: 256,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          console.warn(`SqftResolutionService: Vision API HTTP ${response.status} for image ${imageId}`);
          continue;
        }

        const completion = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const content = completion.choices?.[0]?.message?.content;
        if (!content) {
          continue;
        }

        // Parse the JSON response from the model
        let parsed: { isFloorPlan?: boolean; estimatedSqft?: number | null; reasoning?: string };
        try {
          // Strip markdown code fences if present
          const jsonText = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          parsed = JSON.parse(jsonText) as typeof parsed;
        } catch {
          console.warn(`SqftResolutionService: Failed to parse vision response for image ${imageId}`);
          continue;
        }

        if (!parsed.isFloorPlan || !parsed.estimatedSqft || parsed.estimatedSqft <= 0) {
          continue;
        }

        return {
          resolved: true,
          value: parsed.estimatedSqft,
          tier: 'layout_diagram',
          confidence: 'medium',
          metadata: {
            imageId,
            aiReasoning: parsed.reasoning ?? '',
          },
        };
      } catch (err) {
        console.warn(
          `SqftResolutionService: Error analyzing image ${imageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Continue to next image
      }
    }

    return null;
  }

  /**
   * Tier 3: Look up property square footage from Cook County Assessor records.
   * Returns null if no record is found or on any error.
   */
  private async lookupPublicRecords(address: string): Promise<ResolutionResult | null> {
    const record = await this.assessorClient.lookupByAddress(address);

    if (!record || record.buildingSqft <= 0) {
      return null;
    }

    return {
      resolved: true,
      value: record.buildingSqft,
      tier: 'public_records',
      confidence: 'low',
      metadata: {
        propertyAddress: record.address,
        assessorRecordId: record.pin,
      },
    };
  }
}
