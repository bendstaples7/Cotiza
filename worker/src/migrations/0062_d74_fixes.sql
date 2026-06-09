-- Migration: 0062_d74_fixes.sql
-- Fixes from D-74 testing:
--
--   Issue 1A: Fix plumbing inspection removal rule — productNamePattern was
--             "Certified Plumbing Inspection" with starts_with, but the actual
--             product name is "Plumbing: Certified Plumbing Inspection" so it
--             never matched. Changed to exact match on full product name.
--
--   Issue 2C: Fix contradictory customer note when permit is on the quote.
--             The architecture is now fully compositional:
--               - Default Note Rule: sets a base note with no permit-specific content
--               - note-no-permit (new): appends "does not include permit fees" only
--                 when NO permit is on the quote
--               - append-permit-note (existing): appends "permit IS included" only
--                 when a permit IS on the quote
--             This way the note composes correctly regardless of other appends
--             (e.g. deposit rules, scope disclaimers) that may fire later.
--
-- All INSERTs use INSERT OR IGNORE. All UPDATEs are idempotent.

-- Issue 1A: Fix productNamePattern to match actual product name with prefix
UPDATE rules
SET condition_json = '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Plumbing: Certified Plumbing Inspection","matchMode":"exact"},{"type":"request_text_not_contains","substring":"inspection"}]}',
    action_json = '[{"type":"remove_line_item","productNamePattern":"Plumbing: Certified Plumbing Inspection","matchMode":"exact"}]',
    updated_at = datetime('now')
WHERE id = 'remove-unneeded-plumbing-inspection';

-- Issue 2C step 1: Change Default Note Rule to a neutral base note (no permit content).
-- The permit sentence is now handled by conditional rules below.
UPDATE rules
SET action_json = '[{"type":"set_customer_note","text":"All work will be completed by licensed and insured contractors. Pricing is based on information provided and is subject to change if scope of work changes during construction."}]',
    updated_at = datetime('now')
WHERE id = 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6';

-- Issue 2C step 2: Add rule that appends the "does not include permit fees" sentence
-- ONLY when no permit line item is on the quote.
-- trigger_mode = 'on_create', priority_order = 101 (fires right after default note at 100).
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'note-no-permit',
  'Append No-Permit Disclaimer When No Permit on Quote',
  'When no permit line item is on the quote, appends the standard permit-fees disclaimer to the customer note.',
  (SELECT id FROM rule_groups WHERE name = 'Quote Terms' LIMIT 1),
  101, 1, 'on_create',
  '{"type":"line_item_not_exists","productNamePattern":"Permit","matchMode":"starts_with"}',
  '[{"type":"append_customer_note","text":"Estimate does not include permit fees, or permit coordination fees. If customer would like permits pulled for this work, will require change order at additional cost.","separator":" "}]',
  datetime('now'), datetime('now')
);

-- Issue 2C step 3: Update append-permit-note to priority 102 so it fires after
-- note-no-permit (101). When permit IS on the quote, note-no-permit does not fire
-- (condition fails), and append-permit-note fires instead.
UPDATE rules
SET priority_order = 102,
    updated_at = datetime('now')
WHERE id = 'append-permit-note';
