#!/usr/bin/env node
/**
 * Apply local rule overrides after sync-rules pulls from production.
 *
 * This script re-applies rule changes that exist locally but haven't been
 * deployed to production yet. It runs after sync-rules in the dev startup
 * sequence and is a no-op once the changes are deployed.
 *
 * Each override is idempotent — safe to run multiple times.
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function execSql(sql) {
  const tmpFile = join(tmpdir(), `rule-overrides-${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, sql, 'utf8');
    run(`npx wrangler d1 execute DB --local --file "${tmpFile}"`);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

console.log('[rule-overrides] Applying local rule overrides...');

// Override 1: "Include Painting and Carpentry with Drywall Quote"
// - Clear rule-level scope_constraint (painting fires for all drywall)
// - Add scopeConstraint:"wall" on the baseboard add_line_item action only
// - Stamp locally_modified_at so sync-rules won't overwrite this
const paintingCarpentryOverride = `
UPDATE rules
SET
  scope_constraint = NULL,
  action_json = '[{"type":"add_line_item","productName":"Interior Painting","quantity":1,"unitPrice":100,"placeAfter":"Drywall: Installation of New Drywall"},{"type":"add_line_item","productName":"Materials: Paint Supplies","quantity":1,"unitPrice":100,"placeAfter":"Interior Painting"},{"type":"add_line_item","productName":"Carpentry: Install Baseboard Trim and Shoe","quantity":1,"unitPrice":100,"placeAfter":"Materials: Paint Supplies","scopeConstraint":"wall"}]',
  locally_modified_at = datetime('now'),
  updated_at = datetime('now')
WHERE name LIKE 'Include Painting and Carpentry with Drywall Quote%';
`;

try {
  execSql(paintingCarpentryOverride);
  console.log('[rule-overrides] ✅ Applied: painting/baseboard scope split');
} catch (err) {
  console.warn(`[rule-overrides] ⚠️  Failed to apply painting/baseboard override: ${err.message}`);
}

// Override 2: "remove-unneeded-plumbing-inspection"
// - The product name is "Plumbing: Certified Plumbing Inspection" so the
//   productNamePattern must include the "Plumbing:" prefix. Previous version
//   used "Certified Plumbing Inspection" with starts_with which never matched.
// - Also fixes condition field from "text" to "substring" (schema requirement).
const plumbingInspectionOverride = `
UPDATE rules
SET
  condition_json = '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Plumbing: Certified Plumbing Inspection","matchMode":"exact"},{"type":"request_text_not_contains","substring":"inspection"}]}',
  action_json = '[{"type":"remove_line_item","productNamePattern":"Plumbing: Certified Plumbing Inspection","matchMode":"exact"}]',
  locally_modified_at = datetime('now'),
  updated_at = datetime('now')
WHERE id = 'remove-unneeded-plumbing-inspection';
`;

try {
  execSql(plumbingInspectionOverride);
  console.log('[rule-overrides] ✅ Applied: plumbing inspection removal fix');
} catch (err) {
  console.warn(`[rule-overrides] ⚠️  Failed to apply plumbing inspection override: ${err.message}`);
}

// Override 3: "Default Note Rule" — neutral base text with no permit-specific content.
// The permit sentence is handled by conditional rules: note-no-permit (no permit on quote)
// and append-permit-note (permit IS on quote). This keeps the note composable.
// sync-rules restores the production text on every startup, so this override re-applies it.
const defaultNoteOverride = `
UPDATE rules
SET
  action_json = '[{"type":"set_customer_note","text":"All work will be completed by licensed and insured contractors. Pricing is based on information provided and is subject to change if scope of work changes during construction."}]',
  locally_modified_at = datetime('now'),
  updated_at = datetime('now')
WHERE id = 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6';
`;

try {
  execSql(defaultNoteOverride);
  console.log('[rule-overrides] ✅ Applied: default note rule base text');
} catch (err) {
  console.warn(`[rule-overrides] ⚠️  Failed to apply default note override: ${err.message}`);
}

console.log('[rule-overrides] Done.');
