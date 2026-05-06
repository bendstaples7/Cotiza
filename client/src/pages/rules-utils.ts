import type { ProductivityRate } from 'shared';

/**
 * Pure helper: merge productivity rates into a formula variables map (non-overwrite).
 * Extracted as a pure function to enable Property 7 testing.
 */
export function mergeRatesIntoVariables(
  variables: Record<string, number>,
  rates: ProductivityRate[],
): Record<string, number> {
  const result = { ...variables };
  for (const rate of rates) {
    if (!(rate.variableName in result)) {
      result[rate.variableName] = rate.sqftPerHour;
    }
  }
  return result;
}
