/**
 * Request-body normalizers for the HTTP boundary.
 *
 * Optional id/text fields routinely arrive as empty strings from the client
 * (e.g. a "no channel selected" state sends ""). Forwarding "" — or coercing it
 * to `undefined` — into a service that writes to D1 produces either a bogus row
 * or a D1_TYPE_ERROR. Normalizing at the boundary keeps the rule in one place:
 * empty means null.
 */

/** Trim an optional string field; empty or non-string becomes null. */
export function emptyToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Like {@link emptyToNull}, but preserves an absent field (`undefined`) so
 * PUT/PATCH handlers can distinguish "leave unchanged" (`undefined`) from
 * "clear the value" (`null`).
 */
export function emptyToNullOptional(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return emptyToNull(value);
}
