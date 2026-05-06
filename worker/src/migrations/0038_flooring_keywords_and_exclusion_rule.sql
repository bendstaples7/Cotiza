-- Add discriminating keywords to flooring catalog items so the AI picks the
-- correct flooring type based on what the customer actually said.
-- Also adds a mutual-exclusion rule for Basic vs. Complex laminate (never both on same job).

-- ── Catalog keyword updates ───────────────────────────────────────────────

UPDATE product_catalog
SET keywords = 'laminate complex, herringbone, diagonal, pattern flooring, angled laminate, intricate layout'
WHERE name = 'Flooring: Install new laminate flooring (Complex)';

UPDATE product_catalog
SET keywords = 'hardwood, oak, maple, engineered wood, solid wood, wood floor, hardwood floor'
WHERE name = 'Flooring: Install New Hardwood';

UPDATE product_catalog
SET keywords = 'vinyl installation, LVP, luxury vinyl plank, vinyl plank, waterproof flooring, vinyl floor, new flooring, living space flooring'
WHERE name = 'Flooring: Install new vinyl flooring';

-- ── Mutual-exclusion rule: Basic vs. Complex laminate ─────────────────────
-- A job uses either basic or complex laminate layout, never both.
-- When Complex is on the quote, remove Basic (Complex takes precedence).

INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, trigger_mode, condition_json, action_json, created_at, updated_at) VALUES (
  'excl-laminate-complex-removes-basic',
  'Remove Basic Laminate When Complex Laminate Exists',
  'Removes Flooring: Install new laminate flooring (Basic) when Complex is already on the quote — a job uses one layout type, not both',
  (SELECT id FROM rule_groups WHERE name = 'General' LIMIT 1),
  47, 1, 'chained',
  '{"type":"line_item_exists","productNamePattern":"Flooring: Install new laminate flooring (Complex)","matchMode":"exact"}',
  '[{"type":"remove_line_item","productNamePattern":"Flooring: Install new laminate flooring (Basic)","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);
