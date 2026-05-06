-- Price override rules for materials line items.
-- Uses set_unit_price to enforce correct per-unit prices at quote generation time,
-- overriding whatever unit_price comes from the Jobber catalog sync.
--
-- Prices: Chicago retail (2025) + 10.25% IL/Cook County sales tax + 20% margin, rounded up.
--   Drywall sheet (4x8):        $16 × 1.1025 × 1.20 = $21.17 → $22
--   Interior paint (gallon):    $26 × 1.1025 × 1.20 = $34.40 → $35
--   Exterior paint (gallon):    $37 × 1.1025 × 1.20 = $48.95 → $50
--   Shower wall tile (sqft):    $5.00 × 1.1025 × 1.20 = $6.61 → $7
--   Bathroom floor tile (sqft): $4.00 × 1.1025 × 1.20 = $5.29 → $6
--   Tile supplies (sqft):       $2.50 × 1.1025 × 1.20 = $3.31 → $4
--
-- trigger_mode = 'chained' so these fire after add_line_item rules place the items.

INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, trigger_mode, condition_json, action_json, created_at, updated_at) VALUES ('price-materials-drywall', 'Set Drywall Sheet Price', 'Sets Materials: Drywall unit price to $22/sheet (Chicago retail + IL tax + 20% margin)', (SELECT id FROM rule_groups WHERE name = 'Drywall' LIMIT 1), 70, 1, 'chained', '{"type":"line_item_exists","productNamePattern":"Materials: Drywall","matchMode":"exact"}', '[{"type":"set_unit_price","productNamePattern":"Materials: Drywall","unitPrice":22,"matchMode":"exact"}]', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, trigger_mode, condition_json, action_json, created_at, updated_at) VALUES ('price-materials-interior-paint', 'Set Interior Paint Price', 'Sets Materials: Interior Paint unit price to $35/gallon (Chicago retail + IL tax + 20% margin)', (SELECT id FROM rule_groups WHERE name = 'Painting' LIMIT 1), 71, 1, 'chained', '{"type":"line_item_exists","productNamePattern":"Materials: Interior Paint","matchMode":"exact"}', '[{"type":"set_unit_price","productNamePattern":"Materials: Interior Paint","unitPrice":35,"matchMode":"exact"}]', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, trigger_mode, condition_json, action_json, created_at, updated_at) VALUES ('price-materials-exterior-paint', 'Set Exterior Paint Price', 'Sets Materials: Exterior Paint unit price to $50/gallon (Chicago retail + IL tax + 20% margin)', (SELECT id FROM rule_groups WHERE name = 'Painting' LIMIT 1), 72, 1, 'chained', '{"type":"line_item_exists","productNamePattern":"Materials: Exterior Paint","matchMode":"exact"}', '[{"type":"set_unit_price","productNamePattern":"Materials: Exterior Paint","unitPrice":50,"matchMode":"exact"}]', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, trigger_mode, condition_json, action_json, created_at, updated_at) VALUES ('price-materials-shower-wall-tile', 'Set Shower Wall Tile Price', 'Sets Materials: Shower Wall Tile unit price to $7/sqft (Chicago retail + IL tax + 20% margin)', (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1), 73, 1, 'chained', '{"type":"line_item_exists","productNamePattern":"Materials: Shower Wall Tile","matchMode":"exact"}', '[{"type":"set_unit_price","productNamePattern":"Materials: Shower Wall Tile","unitPrice":7,"matchMode":"exact"}]', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, trigger_mode, condition_json, action_json, created_at, updated_at) VALUES ('price-materials-bathroom-floor-tile', 'Set Bathroom Floor Tile Price', 'Sets Materials: Bathroom Floor Tile unit price to $6/sqft (Chicago retail + IL tax + 20% margin)', (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1), 74, 1, 'chained', '{"type":"line_item_exists","productNamePattern":"Materials: Bathroom Floor Tile","matchMode":"exact"}', '[{"type":"set_unit_price","productNamePattern":"Materials: Bathroom Floor Tile","unitPrice":6,"matchMode":"exact"}]', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, trigger_mode, condition_json, action_json, created_at, updated_at) VALUES ('price-materials-bathroom-tile-supplies', 'Set Bathroom Tile Supplies Price', 'Sets Materials: Bathroom Tile Supplies unit price to $4/sqft (grout, thinset, spacers — Chicago retail + IL tax + 20% margin)', (SELECT id FROM rule_groups WHERE name = 'Tile' LIMIT 1), 75, 1, 'chained', '{"type":"line_item_exists","productNamePattern":"Materials: Bathroom Tile Supplies","matchMode":"exact"}', '[{"type":"set_unit_price","productNamePattern":"Materials: Bathroom Tile Supplies","unitPrice":4,"matchMode":"exact"}]', datetime('now'), datetime('now'));
