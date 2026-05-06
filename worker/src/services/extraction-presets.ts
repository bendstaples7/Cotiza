// ---------------------------------------------------------------------------
// Extraction Presets — Predefined regex patterns for common value extraction
// ---------------------------------------------------------------------------
// Provides preset extraction patterns for square footage, room count, and
// floor count. Presets are resolved at rule creation time so that runtime
// evaluation never depends on preset definitions.
// ---------------------------------------------------------------------------

export interface ExtractionPreset {
  id: string;
  name: string;
  description: string;
  pattern: string;
  variableName: string;
  exampleMatches: string[];
}

// ---------------------------------------------------------------------------
// Predefined presets
// ---------------------------------------------------------------------------

const PRESETS: ExtractionPreset[] = [
  {
    id: 'sqft',
    name: 'Square Footage',
    description: 'Extracts square footage values from text (e.g., "1500 sqft", "1,500 sq ft", "1500 square feet", "1500sf")',
    pattern: '(\\d[\\d,]*(?:\\.\\d+)?)\\s*(?:sq\\.?\\s*ft|sqft|square\\s*feet|sf)',
    variableName: 'sqft',
    exampleMatches: ['1500 sqft', '1,500 sq ft', '1500 square feet', '1500sf'],
  },
  {
    id: 'room_count',
    name: 'Room Count',
    description: 'Extracts room counts from text (e.g., "3 rooms", "3 bedrooms", "3 bathrooms", "3 bed/bath")',
    pattern: '(\\d+)\\s*(?:rooms?|bedrooms?|bathrooms?|bed/?bath)',
    variableName: 'rooms',
    exampleMatches: ['3 rooms', '3 bedrooms', '3 bathrooms', '3 bed/bath'],
  },
  {
    id: 'floor_count',
    name: 'Floor Count',
    description: 'Extracts floor/story counts from text (e.g., "2 floors", "2 stories", "2 levels", "2-story")',
    pattern: '(\\d+)\\s*(?:floors?|stor(?:y|ies)|levels?)',
    variableName: 'floors',
    exampleMatches: ['2 floors', '2 stories', '2 levels', '2-story'],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get all available extraction presets */
export function getExtractionPresets(): ExtractionPreset[] {
  return PRESETS;
}

/** Resolve a preset ID to its definition. Returns null if not found. */
export function resolvePreset(presetId: string): ExtractionPreset | null {
  return PRESETS.find((p) => p.id === presetId) ?? null;
}
