import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guard against duplicate D1 migration numbers.
 *
 * Cloudflare D1 / wrangler track applied migrations by filename and apply them
 * in numeric order. Two files sharing the same NNNN prefix make apply order
 * ambiguous and almost always signal a merge mistake.
 *
 * KNOWN, PENDING duplicate: "0065" currently appears twice
 * (0065_add_client_name_property_address.sql and 0065_deposit_payments.sql).
 * Both were freshly merged and are not yet renumbered. Renumbering must wait
 * until the production `d1_migrations` ledger is confirmed (see the plan's
 * secrets/infra checklist), because renaming an already-applied migration makes
 * wrangler re-run it (the non-idempotent ALTERs would then fail). Once the
 * ledger is reconciled and one file is renumbered (e.g. -> 0067), REMOVE '0065'
 * from the allowlist below so this guard becomes strict again.
 */
const KNOWN_PENDING_DUPLICATES = new Set<string>(['0065']);

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../worker/src/migrations',
);

function migrationFiles(): string[] {
  return readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
}

describe('D1 migration numbering', () => {
  it('every migration filename starts with a 4-digit NNNN_ prefix', () => {
    const bad = migrationFiles().filter((f) => !/^\d{4}_/.test(f));
    expect(bad, `Migration files missing NNNN_ prefix: ${bad.join(', ')}`).toEqual([]);
  });

  it('has no unexpected duplicate migration numbers', () => {
    const counts = new Map<string, number>();
    for (const file of migrationFiles()) {
      const num = file.slice(0, 4);
      counts.set(num, (counts.get(num) ?? 0) + 1);
    }

    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([num]) => num);

    const unexpected = duplicates.filter((num) => !KNOWN_PENDING_DUPLICATES.has(num));
    expect(
      unexpected,
      `Unexpected duplicate migration numbers: ${unexpected.join(', ')}. ` +
        'Renumber the newer file to the next free number.',
    ).toEqual([]);
  });
});
