-- Add scope column to product_catalog for AI line item generation constraints.
-- Scope values: 'any', 'ceiling', 'wall', 'floor', 'perimeter', 'exterior', 'plumbing', 'electrical'
-- NULL means no constraint (same as 'any').
-- The AI prompt reads [scope: ...] annotations and only includes items whose scope matches the request.

-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE product_catalog ADD COLUMN scope TEXT DEFAULT NULL;

-- 'perimeter' = baseboard, shoe trim, crown molding — only valid for wall/floor work, not ceiling-only.
UPDATE product_catalog SET scope = 'perimeter' WHERE name IN (
  'Carpentry: Install Baseboard Trim',
  'Carpentry: Install Baseboard Shoe',
  'Carpentry: Install Baseboard Trim and Shoe',
  'Carpentry: Remove Baseboard Shoe',
  'Carpentry: Stain Baseboard Trim',
  'Carpentry: Crown Molding Installation',
  'Materials: Baseboard Supplies',
  'Materials: Baseboard Trim and Shoe',
  'Materials: Shoe Trim',
  'Misc: Baseboard Caulk',
  'Painting: Caulk / touch ups for baseboard shoe',
  'Tile: Install Durock Baseboard Trim Support',
  'Tile: Tiled Baseboard Trim'
);

-- 'ceiling' = work that only applies to ceilings
UPDATE product_catalog SET scope = 'ceiling' WHERE name IN (
  'Drywall: Ceiling Repairs',
  'Interior Painting: Ceilings',
  'Insulation: Insulate One Interior Ceiling',
  'Tile: Shower Ceiling'
);

-- 'floor' = flooring work
UPDATE product_catalog SET scope = 'floor' WHERE name LIKE 'Flooring:%'
  OR name IN ('Materials: Laminate Flooring', 'Materials: Vinyl Flooring', 'Electrical: Radiant Flooring Install');

-- 'exterior' = exterior work only
UPDATE product_catalog SET scope = 'exterior' WHERE name LIKE 'Exterior:%'
  OR name IN (
    'Exterior Painting',
    'Carpentry: Exterior Post Repair',
    'Carpentry: Exterior Temporary Overhang Support Construction',
    'Carpentry: Install new Exterior Door Slab',
    'Carpentry: Install new Sliding Glass Exterior Door',
    'Carpentry: Roofing',
    'Electrical: Repair Exterior Light Fixture',
    'Electrical: Replace Existing Exterior Light Fixture With New',
    'HVAC: Kitchen Hood Vent Exterior Hole Creation',
    'Insulation: Insulate One Exterior Wall',
    'Materials: Exterior Paint',
    'Materials: Roofing',
    'Materials: Siding Repair',
    'Roofing'
  );
