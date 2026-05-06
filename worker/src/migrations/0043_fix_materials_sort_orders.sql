-- Fix catalog sort orders for materials items that should immediately follow
-- their corresponding labor line items. The Jobber sync uses ON CONFLICT DO NOTHING
-- so these sort_order updates persist across catalog syncs.

UPDATE product_catalog SET sort_order = 363 WHERE name = 'Materials: Drywall';
UPDATE product_catalog SET sort_order = 585 WHERE name = 'Materials: Baseboard Supplies';
UPDATE product_catalog SET sort_order = 586 WHERE name = 'Materials: Baseboard Trim and Shoe';
UPDATE product_catalog SET sort_order = 701 WHERE name = 'Materials: Paint Supplies';
UPDATE product_catalog SET sort_order = 702 WHERE name = 'Materials: Interior Paint';
UPDATE product_catalog SET sort_order = 181 WHERE name = 'Materials: Exterior Paint';
UPDATE product_catalog SET sort_order = 462 WHERE name = 'Materials: Shower Pan';
UPDATE product_catalog SET sort_order = 468 WHERE name = 'Materials: Durock';
UPDATE product_catalog SET sort_order = 491 WHERE name = 'Materials: Redgard';
UPDATE product_catalog SET sort_order = 476 WHERE name = 'Materials: Shower Wall Tile';
UPDATE product_catalog SET sort_order = 466 WHERE name = 'Materials: Bathroom Floor Tile';
UPDATE product_catalog SET sort_order = 467 WHERE name = 'Materials: Bathroom Tile Supplies';
UPDATE product_catalog SET sort_order = 88 WHERE name = 'Materials: Framing';
UPDATE product_catalog SET sort_order = 413 WHERE name = 'Materials: Hardwood Floor';
UPDATE product_catalog SET sort_order = 414 WHERE name = 'Materials: Laminate Flooring';
UPDATE product_catalog SET sort_order = 417 WHERE name = 'Materials: Vinyl Flooring';
UPDATE product_catalog SET sort_order = 244 WHERE name = 'Materials: Rough Plumbing';
UPDATE product_catalog SET sort_order = 42 WHERE name = 'Materials: Demo Supplies';
