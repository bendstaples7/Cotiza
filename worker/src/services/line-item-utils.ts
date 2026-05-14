/**
 * Utility functions for post-processing AI-generated line items.
 */

import type { ProductCatalogEntry, AuditEntry } from 'shared';
import { SPACE_ALLOCATIONS } from './space-allocation-service.js';

/**
 * Checks if a line item description starts with a known space label from the
 * SPACE_ALLOCATIONS lookup table. Returns the matching label, or null if none.
 *
 * This is used by deduplicateLineItems to prevent collapsing space-split items
 * (e.g., "Basement — Drywall" and "Master Bedroom — Drywall" are distinct).
 */
export function extractSpacePrefix(description: string): string | null {
  if (!description) return null;
  const lower = description.toLowerCase();
  for (const entry of SPACE_ALLOCATIONS) {
    const labelLower = entry.label.toLowerCase();
    // Match if description starts with the label followed by a separator character
    // (or end of string). This prevents "Bathroom" from matching "Bathroom Tile"
    // when "Bathroom" is not a known space label prefix in that context.
    if (lower.startsWith(labelLower)) {
      const nextChar = lower[labelLower.length];
      if (nextChar === undefined || /[\s\-—:,()\/]/.test(nextChar)) {
        return entry.label;
      }
    }
  }
  return null;
}

/**
 * Merge duplicate line items that share the same product name (case-insensitive).
 *
 * When duplicates are found the rule-engine version is preferred (the item
 * with a non-empty `ruleIdsApplied` array wins). If neither or both have
 * rule IDs the first occurrence wins. Quantities are summed, the higher
 * confidence score is kept, and rule IDs are merged.
 *
 * Items with blank/empty productName are always treated as distinct and never
 * merged, since they represent unmatched or incomplete entries.
 *
 * This runs as a post-validation step to catch cases where the AI
 * returns the same product multiple times despite prompt instructions,
 * or where both the AI and the rules engine add the same product.
 */
export function deduplicateLineItems<
  T extends {
    productName: string;
    description?: string;
    quantity: number;
    unitPrice: number;
    confidenceScore: number;
    originalText: string;
    ruleIdsApplied?: string[];
  },
>(items: T[]): T[] {
  const seen = new Map<string, T>();
  const order: string[] = [];
  let blankIndex = 0;

  for (const item of items) {
    const nameTrimmed = String(item.productName ?? '').trim().toLowerCase();

    // Blank product names are always distinct — use a unique key per item
    if (!nameTrimmed) {
      const uniqueKey = `__blank_${blankIndex++}`;
      seen.set(uniqueKey, { ...item });
      order.push(uniqueKey);
      continue;
    }

    // Key by product name + space prefix — items for the same product but
    // different spaces (e.g. "Basement — Drywall" vs "Master Bedroom — Drywall")
    // are distinct and must NOT be merged (REQ-2.4).
    const spacePrefix = extractSpacePrefix(item.description ?? '');
    const key = spacePrefix ? `${nameTrimmed}|${spacePrefix}` : nameTrimmed;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, { ...item });
      order.push(key);
      continue;
    }

    // Determine which item is authoritative: prefer the one with rule IDs
    const existingHasRules = (existing.ruleIdsApplied ?? []).length > 0;
    const newHasRules = (item.ruleIdsApplied ?? []).length > 0;

    // If the new item has rules and the existing doesn't, the new item is
    // authoritative — swap it in as the base, keeping the existing's
    // additive fields (quantity, original text).
    const base = (!existingHasRules && newHasRules) ? item : existing;
    const other = (base === item) ? existing : item;

    // Log price divergence for traceability
    if (base.unitPrice !== other.unitPrice) {
      console.warn(
        `[deduplicateLineItems] Price divergence on "${nameTrimmed}": ` +
        `keeping ${base.unitPrice} (${(base.ruleIdsApplied ?? []).length > 0 ? 'rule' : 'AI'}), ` +
        `dropping ${other.unitPrice} (${(other.ruleIdsApplied ?? []).length > 0 ? 'rule' : 'AI'})`
      );
    }

    const merged = { ...base };
    merged.quantity = base.quantity + other.quantity;
    merged.confidenceScore = Math.max(base.confidenceScore, other.confidenceScore);

    // Merge original text
    if (other.originalText && other.originalText !== base.originalText) {
      merged.originalText = base.originalText
        ? `${base.originalText}; ${other.originalText}`
        : other.originalText;
    }

    // Merge rule IDs (union, no duplicates)
    const baseRules = base.ruleIdsApplied ?? [];
    const otherRules = other.ruleIdsApplied ?? [];
    if (baseRules.length > 0 || otherRules.length > 0) {
      const ruleSet = new Set([...baseRules, ...otherRules]);
      merged.ruleIdsApplied = [...ruleSet];
    }

    seen.set(key, merged);
  }

  // Preserve original insertion order
  return order.map((key) => seen.get(key)!);
}

/**
 * Sort line items by their catalog sort order.
 * Items whose product name matches a catalog entry are sorted by that entry's sortOrder.
 * Items without a catalog match keep their relative position (stable sort).
 * This ensures quotes follow the renovation workflow sequence.
 */
export function sortLineItemsByCatalog<
  T extends { productName: string },
>(items: T[], catalog: ProductCatalogEntry[]): T[] {
  // Build a name→sortOrder lookup (case-insensitive)
  const sortOrderByName = new Map<string, number>();
  for (const entry of catalog) {
    const key = entry.name.trim().toLowerCase();
    if (key) {
      const existing = sortOrderByName.get(key);
      const newOrder = entry.sortOrder ?? 500;
      if (existing === undefined || newOrder < existing) {
        sortOrderByName.set(key, newOrder);
      }
    }
  }

  // Stable sort: items with the same sort order keep their relative position
  const indexed = items.map((item, i) => ({ item, originalIndex: i }));
  indexed.sort((a, b) => {
    const aOrder = sortOrderByName.get(a.item.productName.trim().toLowerCase()) ?? 500;
    const bOrder = sortOrderByName.get(b.item.productName.trim().toLowerCase()) ?? 500;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.originalIndex - b.originalIndex; // stable
  });

  return indexed.map(({ item }) => item);
}


/**
 * Check if the rules engine actually modified line items (not just enrichment-only entries).
 * Returns true only when rules added, removed, or moved line items.
 * Enrichment-only entries (extract_request_context, set_quantity, etc.) have identical
 * before/after snapshots and should not count as modifications.
 */
export function rulesModifiedLineItems(auditTrail?: AuditEntry[]): boolean {
  if (!auditTrail) return false;
  const ORDERING_ACTIONS = new Set(['add_line_item', 'remove_line_item', 'move_line_item']);
  return auditTrail.some((e) => {
    if (e.ruleId === '__engine__') return false;
    return ORDERING_ACTIONS.has(e.action.type) && (e.afterSnapshot.length > 0 || e.beforeSnapshot.length > 0);
  });
}
