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
 */
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

    expect(
      duplicates,
      `Unexpected duplicate migration numbers: ${duplicates.join(', ')}. ` +
        'Renumber the newer file to the next free number.',
    ).toEqual([]);
  });
});
