-- Add locally_modified_at column to rules table.
-- When set, sync-rules will skip overwriting this rule with the production version,
-- preserving local migrations and manual edits until the change is deployed to production.

-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE rules ADD COLUMN locally_modified_at TEXT DEFAULT NULL;

-- Stamp the painting/baseboard rule as locally modified so sync-rules won't overwrite it.
-- This preserves the scopeConstraint:"wall" on the baseboard action_json from migration 0052.
UPDATE rules
SET locally_modified_at = datetime('now')
WHERE name LIKE 'Include Painting and Carpentry with Drywall Quote%';
