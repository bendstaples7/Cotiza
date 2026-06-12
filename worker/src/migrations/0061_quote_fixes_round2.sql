-- Migration: 0061_quote_fixes_round2.sql
-- Fixes observed in D-073 local testing:
--
--   1C. Fix plumbing inspection removal rule — condition used "text" but schema needs "substring".
--       Also upgrades to compound condition: line_item_exists AND request_text_not_contains.
--   2C. Assign explicit sequential sort_orders for shower sequence items (part 1 of 2).
--   2C. Replace shower-surround-prereqs with placeAfter chaining (part 2 of 2).
--   4A+B. Add chained rules so default_hours is applied to Durock, Waterproof, Schluter.
--   7C. Add append_customer_note rule when permit is on the quote.
--
-- All INSERTs use INSERT OR IGNORE. All UPDATEs are idempotent.

-- 1C. Fix plumbing inspection rule condition (text → substring, compound)
UPDATE rules
SET condition_json = '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Certified Plumbing Inspection","matchMode":"starts_with"},{"type":"request_text_not_contains","substring":"inspection"}]}',
    updated_at = datetime('now')
WHERE id = 'remove-unneeded-plumbing-inspection';

-- 2C part 1. Explicit sequential sort_orders for shower construction sequence
UPDATE product_catalog SET sort_order = 460, updated_at = datetime('now') WHERE name = 'Tile: Install Durock Shower Surround';
UPDATE product_catalog SET sort_order = 461, updated_at = datetime('now') WHERE name = 'Materials: Durock';
UPDATE product_catalog SET sort_order = 462, updated_at = datetime('now') WHERE name = 'Tile: Waterproof Shower Surround';
UPDATE product_catalog SET sort_order = 463, updated_at = datetime('now') WHERE name = 'Materials: Redgard';
UPDATE product_catalog SET sort_order = 464, updated_at = datetime('now') WHERE name = 'Tile: Install Tiled Shower Surround';
UPDATE product_catalog SET sort_order = 465, updated_at = datetime('now') WHERE name = 'Tile: Schluter Tile Edge Trim';

-- 2C part 2. Replace shower-surround-prereqs with placeAfter chaining
-- Durock labor anchors before tile; each subsequent item uses placeAfter the previous.
UPDATE rules
SET action_json = '[{"type":"add_line_item","productName":"Tile: Install Durock Shower Surround","quantity":1,"unitPrice":65,"placeBefore":"Tile: Install Tiled Shower Surround"},{"type":"add_line_item","productName":"Materials: Durock","quantity":1,"unitPrice":200,"placeAfter":"Tile: Install Durock Shower Surround"},{"type":"add_line_item","productName":"Tile: Waterproof Shower Surround","quantity":1,"unitPrice":65,"placeAfter":"Materials: Durock"},{"type":"add_line_item","productName":"Materials: Redgard","quantity":1,"unitPrice":150,"placeAfter":"Tile: Waterproof Shower Surround"}]',
    updated_at = datetime('now')
WHERE id = 'shower-surround-prereqs';

-- 4B. Individual compute_quantity rules for Durock Shower Surround, Waterproof, and Schluter.
-- These trigger when the item exists and current quantity = 1 (AI/rule default).
-- The rules-engine compute_quantity case checks quantity_mode = 'hourly' on the
-- catalog entry and applies default_hours when quantity is 1. Formula 'sqft' is
-- syntactically valid but never evaluated for hourly-mode items.
-- priority_order 27-29: runs after on_create compute rules (20-25) and apply-hourly-defaults (26).
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-tile-durock-shower-hours',
  'Apply Default Hours: Durock Shower Surround',
  'Applies default_hours (6) to Tile: Install Durock Shower Surround when quantity is still 1 and no historical data changed it.',
  (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1),
  27, 1, 'chained',
  '{"type":"line_item_exists","productNamePattern":"Tile: Install Durock Shower Surround","matchMode":"exact"}',
  '[{"type":"compute_quantity","productNamePattern":"Tile: Install Durock Shower Surround","formula":"sqft","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-tile-waterproof-shower-hours',
  'Apply Default Hours: Waterproof Shower Surround',
  'Applies default_hours (4) to Tile: Waterproof Shower Surround when quantity is still 1 and no historical data changed it.',
  (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1),
  28, 1, 'chained',
  '{"type":"line_item_exists","productNamePattern":"Tile: Waterproof Shower Surround","matchMode":"exact"}',
  '[{"type":"compute_quantity","productNamePattern":"Tile: Waterproof Shower Surround","formula":"sqft","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-tile-schluter-hours',
  'Apply Default Hours: Schluter Tile Edge Trim',
  'Applies default_hours (2) to Tile: Schluter Tile Edge Trim when quantity is still 1 and no historical data changed it.',
  (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1),
  29, 1, 'chained',
  '{"type":"line_item_exists","productNamePattern":"Tile: Schluter Tile Edge Trim","matchMode":"exact"}',
  '[{"type":"compute_quantity","productNamePattern":"Tile: Schluter Tile Edge Trim","formula":"sqft","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);

-- 7C. Append note when permit is on the quote
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'append-permit-note',
  'Append Permit-Included Note When Permit Is on Quote',
  'When a permit line item is on the quote, appends a clarifying sentence so the default permit-fee disclaimer does not contradict the included permit.',
  (SELECT id FROM rule_groups WHERE name = 'Quote Terms' LIMIT 1),
  101, 1, 'chained',
  '{"type":"line_item_exists","productNamePattern":"Permit","matchMode":"starts_with"}',
  '[{"type":"append_customer_note","text":"Note: A permit is included in this estimate at the price listed. Permit coordination fees (expediting, runner fees, etc.) are not included and would be billed as a change order if required.","separator":" "}]',
  datetime('now'), datetime('now')
);
