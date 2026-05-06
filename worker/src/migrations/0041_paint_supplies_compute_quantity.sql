-- Scale Materials: Paint Supplies quantity with number of paint gallons (sqft / 350).
-- One unit of paint supplies per gallon of paint needed.

INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, trigger_mode, condition_json, action_json, created_at, updated_at) VALUES (
  'cq-materials-paint-supplies',
  'Compute Paint Supplies Quantity from Sqft',
  'Sets Materials: Paint Supplies quantity to sqft / 350 (one unit per gallon of paint needed)',
  (SELECT id FROM rule_groups WHERE name = 'Painting' LIMIT 1),
  35, 1, 'chained',
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Materials: Paint Supplies","matchMode":"exact"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)","variableName":"sqft"}]}',
  '[{"type":"compute_quantity","productNamePattern":"Materials: Paint Supplies","formula":"sqft / 350","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);
