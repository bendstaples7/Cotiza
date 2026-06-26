/**
 * D1 rejects JavaScript `undefined` bind values with a cryptic
 * "D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'".
 *
 * `safeBind` coerces any `undefined` argument to `null` (the correct SQL
 * representation of "no value") before binding, so a single missing optional
 * field can never crash an entire request. Coerced positions are logged so the
 * underlying caller bug stays visible instead of silently passing.
 *
 * Use this in place of `stmt.bind(...)` for inserts/updates that include
 * optional columns.
 */
export function safeBind(stmt: D1PreparedStatement, ...values: unknown[]): D1PreparedStatement {
  const coercedIndexes: number[] = [];
  const sanitized = values.map((value, index) => {
    if (value === undefined) {
      coercedIndexes.push(index);
      return null;
    }
    return value;
  });

  if (coercedIndexes.length > 0) {
    console.warn(
      `[safeBind] Coerced undefined bind value(s) to null at index ${coercedIndexes.join(', ')}. ` +
        'Pass null explicitly for optional columns.',
    );
  }

  return stmt.bind(...sanitized);
}
