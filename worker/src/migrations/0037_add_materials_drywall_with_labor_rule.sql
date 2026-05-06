-- Add Materials: Drywall whenever Drywall: Installation of New Drywall is on the quote.
-- Fixes the gap where drywall labor is AI-matched directly (not via a framing rule),
-- leaving no rule to add the materials line item.
-- trigger_mode = 'chained', priority 4 — fires after the existing drywall add rules.

INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, trigger_mode, condition_json, action_json, created_at, updated_at) VALUES (
  'add-materials-drywall-with-labor',
  'Add Drywall Materials with Drywall Labor',
  'Adds Materials: Drywall after Drywall: Installation of New Drywall whenever drywall labor is on the quote',
  (SELECT id FROM rule_groups WHERE name = 'Drywall' LIMIT 1),
  4, 1, 'chained',
  '{"type":"line_item_exists","productNamePattern":"Drywall: Installation of New Drywall","matchMode":"exact"}',
  '[{"type":"add_line_item","productName":"Materials: Drywall","quantity":1,"unitPrice":22,"placeAfter":"Drywall: Installation of New Drywall"}]',
  datetime('now'), datetime('now')
);
