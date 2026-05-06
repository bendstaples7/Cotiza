-- Bulk-insert compute_quantity rules for all productivity-rate-driven labor line items.
-- Each rule fires when the matching line item exists in the quote AND sqft is resolvable.
--
-- The compound condition uses:
--   1. line_item_exists  — ensures the rule only targets the right product
--   2. request_text_extract — extracts sqft from the customer request text;
--      if sqft was already resolved by the SqftResolutionService it is used
--      directly from preResolvedContext without re-extracting.
--
-- Formulas reference productivity rate variables seeded in migration 0030.
-- All rules use trigger_mode = 'on_create' and priority_order 20-25.
-- Rule group IDs are stable UUIDs set in migration 0017_trade_rule_groups.sql.

-- ── Drywall: Installation of New Drywall ─────────────────────────────────
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-drywall-install',
  'Compute Drywall Labor Hours from Sqft',
  'Sets quantity to sqft / drywall_rate (40 sqft/hr) for new drywall installation',
  (SELECT id FROM rule_groups WHERE name = 'Drywall' LIMIT 1),
  20, 1, 'on_create',
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Drywall: Installation of New Drywall","matchMode":"exact"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)","variableName":"sqft"}]}',
  '[{"type":"compute_quantity","productNamePattern":"Drywall: Installation of New Drywall","formula":"sqft / drywall_rate","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);

-- ── Interior Painting ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-interior-painting',
  'Compute Interior Painting Hours from Sqft',
  'Sets quantity to sqft / paint_rate (100 sqft/hr) for interior painting',
  (SELECT id FROM rule_groups WHERE name = 'Painting' LIMIT 1),
  21, 1, 'on_create',
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Interior Painting","matchMode":"exact"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)","variableName":"sqft"}]}',
  '[{"type":"compute_quantity","productNamePattern":"Interior Painting","formula":"sqft / paint_rate","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);

-- ── Interior Painting: Ceilings ───────────────────────────────────────────
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-painting-ceilings',
  'Compute Ceiling Painting Hours from Sqft',
  'Sets quantity to sqft / paint_ceiling_rate (80 sqft/hr) for ceiling painting',
  (SELECT id FROM rule_groups WHERE name = 'Painting' LIMIT 1),
  22, 1, 'on_create',
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Interior Painting: Ceilings","matchMode":"exact"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)","variableName":"sqft"}]}',
  '[{"type":"compute_quantity","productNamePattern":"Interior Painting: Ceilings","formula":"sqft / paint_ceiling_rate","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);

-- ── Tile: Install Tiled Shower Surround ───────────────────────────────────
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-tile-shower-surround',
  'Compute Shower Surround Tile Hours from Sqft',
  'Sets quantity to sqft / tile_shower_rate (8 sqft/hr) for tiled shower surround',
  (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1),
  23, 1, 'on_create',
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Tile: Install Tiled Shower Surround","matchMode":"exact"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)","variableName":"sqft"}]}',
  '[{"type":"compute_quantity","productNamePattern":"Tile: Install Tiled Shower Surround","formula":"sqft / tile_shower_rate","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);

-- ── Tile: Install and Grout New Tile Floor ────────────────────────────────
-- Uses starts_with to match both capitalisation variants in the catalog.
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-tile-floor',
  'Compute Tile Floor Hours from Sqft',
  'Sets quantity to sqft / tile_floor_rate (12 sqft/hr) for tile floor installation',
  (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1),
  24, 1, 'on_create',
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Tile: Install and grout new Tile Floor","matchMode":"starts_with"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)","variableName":"sqft"}]}',
  '[{"type":"compute_quantity","productNamePattern":"Tile: Install and grout new Tile Floor","formula":"sqft / tile_floor_rate","matchMode":"starts_with"}]',
  datetime('now'), datetime('now')
);

-- ── Tile: Bath Surround ───────────────────────────────────────────────────
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-tile-bath-surround',
  'Compute Bath Surround Tile Hours from Sqft',
  'Sets quantity to sqft / tile_bath_rate (8 sqft/hr) for bath surround tile',
  (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1),
  25, 1, 'on_create',
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Tile: Bath Surround","matchMode":"exact"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)","variableName":"sqft"}]}',
  '[{"type":"compute_quantity","productNamePattern":"Tile: Bath Surround","formula":"sqft / tile_bath_rate","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);
