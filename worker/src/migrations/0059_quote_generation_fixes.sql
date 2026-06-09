-- Migration: 0059_quote_generation_fixes.sql
-- Addresses three quote generation issues observed in D-731 (bathroom renovation):
--
--   1. Permit sort order: bump to 900 so it always appears last on the quote.
--   2. Spurious plumbing inspection: rule to remove it unless explicitly requested.
--   3. Shower surround construction sequence: auto-add Durock + RedGard prereqs.
--
-- NOTE: The sqft-driven quantity overcount for tile labor is NOT fixed here
-- with hard caps. Tile jobs legitimately range 8-25+ hours. The root fix is
-- tracked separately (see PR description for three proposed approaches).
--
-- All INSERTs use INSERT OR IGNORE for idempotency.
-- No schema changes in this migration (data-only: UPDATE and INSERT OR IGNORE).

-- 1. Permit sort_order to 900 so it sorts last
UPDATE product_catalog
SET sort_order = 900
WHERE name LIKE '%ermit%'
  AND sort_order < 900;

-- 2. Remove Certified Plumbing Inspection unless customer explicitly asked for it
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'remove-unneeded-plumbing-inspection',
  'Remove Plumbing Inspection Unless Explicitly Requested',
  'Removes any Certified Plumbing Inspection line item when the request does not mention inspection. Prevents AI hallucination of this service.',
  (SELECT id FROM rule_groups WHERE name = 'Plumbing' LIMIT 1),
  5, 1, 'chained',
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Certified Plumbing Inspection","matchMode":"starts_with"},{"type":"request_text_not_contains","text":"inspection"}]}',
  '[{"type":"remove_line_item","productNamePattern":"Certified Plumbing Inspection","matchMode":"starts_with"}]',
  datetime('now'), datetime('now')
);

-- 3. Shower surround construction sequence: add Durock + RedGard before tile
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'shower-surround-prereqs',
  'Add Shower Surround Prerequisites (Durock + RedGard)',
  'When Tile: Install Tiled Shower Surround is on the quote, ensures Durock labor, Durock materials, RedGard waterproofing labor, and RedGard materials are included in construction sequence order before the tile install.',
  (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1),
  15, 1, 'on_create',
  '{"type":"line_item_exists","productNamePattern":"Tile: Install Tiled Shower Surround","matchMode":"exact"}',
  '[{"type":"add_line_item","productName":"Tile: Install Durock Shower Surround","quantity":1,"unitPrice":65,"placeBefore":"Tile: Install Tiled Shower Surround"},{"type":"add_line_item","productName":"Materials: Durock","quantity":1,"unitPrice":200,"placeBefore":"Tile: Install Tiled Shower Surround"},{"type":"add_line_item","productName":"Tile: Waterproof Shower Surround","quantity":1,"unitPrice":65,"placeBefore":"Tile: Install Tiled Shower Surround"},{"type":"add_line_item","productName":"Materials: Redgard","quantity":1,"unitPrice":150,"placeBefore":"Tile: Install Tiled Shower Surround"}]',
  datetime('now'), datetime('now')
);
