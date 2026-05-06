/**
 * Pure-function module for parsing line items from historical quote message text.
 * Supports multiple formats commonly found in Jobber quote messages.
 *
 * This module never throws — all functions return safe defaults on invalid input.
 */

export interface ParsedLineItem {
  productName: string;
  quantity: number;
  unitPrice?: number;
}

/**
 * Parse line items from a quote message string.
 *
 * Supports multiple formats:
 * - Em-dash format: "ProductName — Quantity x UnitPrice" (from Jobber)
 * - Tab-separated: "ProductName\tQuantity\tUnitPrice"
 * - Comma-separated: "ProductName, Quantity, UnitPrice"
 *
 * Returns empty array for unparseable input. Never throws.
 * Discards entries where quantity is not a positive finite number.
 */
export function parseLineItems(message: string): ParsedLineItem[] {
  try {
    if (!message || typeof message !== 'string') return [];

    const lines = message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const results: ParsedLineItem[] = [];

    for (const line of lines) {
      const parsed = parseEmDash(line) ?? parseTabSeparated(line) ?? parseCommaSeparated(line);
      if (parsed && isValidQuantity(parsed.quantity)) {
        results.push(parsed);
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Format parsed line items into canonical string representation.
 * Uses the "ProductName — Quantity x UnitPrice" format.
 * Each line item is separated by a newline.
 */
export function printLineItems(items: ParsedLineItem[]): string {
  if (!items || !Array.isArray(items)) return '';

  return items
    .filter((item) => item.productName && isValidQuantity(item.quantity))
    .map((item) => {
      const qty = formatNumber(item.quantity);
      if (item.unitPrice != null && isFinite(item.unitPrice)) {
        return `${item.productName} \u2014 ${qty} x ${formatNumber(item.unitPrice)}`;
      }
      return `${item.productName} \u2014 ${qty}`;
    })
    .join('\n');
}

// ── Internal parsers ──────────────────────────────────────────────────────────

/**
 * Parse em-dash format: "ProductName — Quantity x UnitPrice"
 * The em-dash (—) separates the product name from quantity info.
 * Quantity may be followed by "x UnitPrice" or stand alone.
 */
function parseEmDash(line: string): ParsedLineItem | null {
  // Match em-dash (—) or spaced en-dash ( – ) as separator
  const dashIndex = line.indexOf('\u2014');
  const enDashIndex = dashIndex === -1 ? line.indexOf(' \u2013 ') : -1;

  const separatorIndex = dashIndex !== -1 ? dashIndex : enDashIndex;
  if (separatorIndex === -1) return null;

  const separatorLength = dashIndex !== -1 ? 1 : 3; // en-dash has surrounding spaces
  const productName = line.slice(0, separatorIndex).trim();
  const rest = line.slice(separatorIndex + separatorLength).trim();

  if (!productName || !rest) return null;

  // Try "Quantity x UnitPrice" pattern
  const qtyPriceMatch = rest.match(/^([\d,]+(?:\.\d+)?)\s*[xX\xd7]\s*\$?([\d,]+(?:\.\d+)?)$/);
  if (qtyPriceMatch) {
    const quantity = parseNumeric(qtyPriceMatch[1]);
    const unitPrice = parseNumeric(qtyPriceMatch[2]);
    if (quantity !== null) {
      return { productName, quantity, ...(unitPrice !== null ? { unitPrice } : {}) };
    }
  }

  // Try quantity-only pattern (just a number after the dash)
  const qtyOnlyMatch = rest.match(/^([\d,]+(?:\.\d+)?)$/);
  if (qtyOnlyMatch) {
    const quantity = parseNumeric(qtyOnlyMatch[1]);
    if (quantity !== null) {
      return { productName, quantity };
    }
  }

  return null;
}

/**
 * Parse tab-separated format: "ProductName\tQuantity\tUnitPrice"
 * At least two tab-separated fields required (name + quantity).
 */
function parseTabSeparated(line: string): ParsedLineItem | null {
  if (!line.includes('\t')) return null;

  const parts = line.split('\t').map((p) => p.trim());
  if (parts.length < 2) return null;

  const productName = parts[0];
  if (!productName) return null;

  const quantity = parseNumeric(parts[1]);
  if (quantity === null) return null;

  const unitPrice = parts.length >= 3 ? parseNumeric(parts[2]) : null;

  return { productName, quantity, ...(unitPrice !== null ? { unitPrice } : {}) };
}

/**
 * Parse comma-separated format: "ProductName, Quantity, UnitPrice"
 * Requires at least two comma-separated fields where the second is numeric.
 * The product name must not be purely numeric to avoid false positives.
 */
function parseCommaSeparated(line: string): ParsedLineItem | null {
  if (!line.includes(',')) return null;

  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 2) return null;

  const productName = parts[0];
  if (!productName) return null;

  // Avoid false positives: product name should not be purely numeric
  if (/^\$?[\d,.]+$/.test(productName)) return null;

  const quantity = parseNumeric(parts[1]);
  if (quantity === null) return null;

  const unitPrice = parts.length >= 3 ? parseNumeric(parts[2]) : null;

  return { productName, quantity, ...(unitPrice !== null ? { unitPrice } : {}) };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a numeric string, stripping commas and optional leading $.
 * Returns null if the result is not a finite number.
 */
function parseNumeric(value: string): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[$,]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!isFinite(num)) return null;
  return num;
}

/** Check if a quantity is a positive finite number */
function isValidQuantity(qty: number): boolean {
  return typeof qty === 'number' && isFinite(qty) && qty > 0;
}

/** Format a number, removing unnecessary trailing zeros */
function formatNumber(n: number): string {
  // Use a fixed precision that avoids floating point noise
  const s = Number(n.toFixed(10));
  return String(s);
}
