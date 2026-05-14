export interface SpaceAllocationResult {
  fraction: number;
  normalizedLabel: string;
  estimatedSqft: number; // Math.round(totalSqft * fraction / 10) * 10
}

interface SpaceAllocationEntry {
  keywords: string[];
  fraction: number;
  label: string;
}

// Ordered most-specific first so "master bedroom" matches before "bedroom"
export const SPACE_ALLOCATIONS: SpaceAllocationEntry[] = [
  { keywords: ['master bedroom', 'primary bedroom', 'master suite'], fraction: 1 / 8, label: 'Master Bedroom' },
  { keywords: ['bedroom'], fraction: 1 / 10, label: 'Bedroom' },
  { keywords: ['basement', 'lower level', 'lower floor'], fraction: 1 / 3, label: 'Basement' },
  { keywords: ['kitchen'], fraction: 1 / 10, label: 'Kitchen' },
  { keywords: ['living room', 'great room', 'family room', 'front room'], fraction: 1 / 8, label: 'Living Area' },
  { keywords: ['dining room'], fraction: 1 / 12, label: 'Dining Room' },
  { keywords: ['bathroom', 'half bath', 'powder room', 'full bath'], fraction: 1 / 20, label: 'Bathroom' },
  { keywords: ['hallway', 'foyer', 'entryway', 'mudroom', 'entry'], fraction: 1 / 20, label: 'Hallway/Entry' },
  { keywords: ['laundry', 'utility room', 'mechanical room'], fraction: 1 / 20, label: 'Utility Room' },
  { keywords: ['garage'], fraction: 1 / 4, label: 'Garage' },
  { keywords: ['attic'], fraction: 1 / 3, label: 'Attic' },
];

/**
 * Resolves a space name to an allocation fraction and estimated sqft.
 *
 * Matching rules (case-insensitive, after stripping leading "the "):
 *   - spaceName contains keyword (normalized input contains the keyword)
 *
 * The table is ordered most-specific first so "master bedroom" matches before
 * "bedroom" when the customer says "master bedroom".
 *
 * Returns the first match (table is ordered most-specific first), or null if no match.
 */
export function resolveSpaceAllocation(
  spaceName: string,
  totalSqft: number,
): SpaceAllocationResult | null {
  // Guard: empty or invalid input
  if (!spaceName) return null;
  const normalized = spaceName.toLowerCase().replace(/^the\s+/, '').trim();
  if (normalized === '') return null;
  if (!Number.isFinite(totalSqft) || totalSqft <= 0) return null;

  for (const entry of SPACE_ALLOCATIONS) {
    // Only check normalized.includes(keyword) — spaceName contains the keyword.
    // The reverse (keyword.includes(normalized)) caused "bedroom" to match
    // "master bedroom" entries because "bedroom" ⊆ "master bedroom".
    const matched = entry.keywords.some(
      (keyword) => normalized.includes(keyword),
    );

    if (matched) {
      return {
        fraction: entry.fraction,
        normalizedLabel: entry.label,
        estimatedSqft: Math.round((totalSqft * entry.fraction) / 10) * 10,
      };
    }
  }

  return null;
}
