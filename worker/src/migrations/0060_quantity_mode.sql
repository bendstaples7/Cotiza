-- Migration: 0060_quantity_mode.sql
-- Adds quantity_mode and default_hours columns to product_catalog.
--
-- quantity_mode controls how a product quantity is determined at quote generation:
--   sqft    - computed from space-scoped square footage (flooring, drywall, paint)
--   hourly  - derived from QuantityEngine historical median + default_hours fallback
--             (tile labor, shower surrounds, plumbing labor - never uses sqft formulas)
--   fixed   - always quantity 1; sqft formulas never run (permits, inspections)
--
-- default_hours is the fallback for hourly-mode items when historical data is
-- insufficient (< 2 data points or confidence below threshold).
--
-- Existing products default to NULL (treated as sqft) for backward compatibility.

-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE product_catalog ADD COLUMN quantity_mode TEXT DEFAULT NULL;

-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE product_catalog ADD COLUMN default_hours REAL DEFAULT NULL;

-- Tile labor: hourly mode (quoted by labor hours, never by sqft)
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 25 WHERE name = 'Tile: Install Tiled Shower Surround';
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 14 WHERE name = 'Tile: Bath Surround';
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 18 WHERE name LIKE 'Tile: Install and grout new Tile Floor%';
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 6  WHERE name = 'Tile: Install Durock Shower Surround';
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 4  WHERE name = 'Tile: Waterproof Shower Surround';
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 3  WHERE name = 'Tile: Construct Shower Pan';
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 2  WHERE name = 'Tile: Schluter Tile Edge Trim';
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 6  WHERE name LIKE 'Tile: Install Durock Baseboard%';

-- Plumbing labor: hourly mode
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 3  WHERE name LIKE 'Plumbing: Re-connect%';
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 16 WHERE name = 'Plumbing: Rough Connection for Shower Drain';
UPDATE product_catalog SET quantity_mode = 'hourly', default_hours = 4  WHERE name LIKE 'Plumbing: Install new%';

-- Fixed items: always qty 1
UPDATE product_catalog SET quantity_mode = 'fixed' WHERE name LIKE '%ermit%';
UPDATE product_catalog SET quantity_mode = 'fixed' WHERE name LIKE '%nspection%';

-- Sqft items: explicit (already behave correctly; setting for UI display clarity)
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name IN ('Drywall: Installation of New Drywall', 'Drywall: Ceiling Repairs', 'Interior Painting', 'Interior Painting: Ceilings', 'Exterior Painting', 'Exterior: Power Wash and Paint Prep');
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name LIKE 'Flooring:%';
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name LIKE 'Carpentry: Install New Plywood Sub Floor%';
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name LIKE 'Carpentry: Subfloor%';
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name LIKE 'Carpentry: Install Baseboard%';
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name LIKE 'Carpentry: Crown Molding%';
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name LIKE 'Carpentry: Wainscoting%';
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name LIKE 'Carpentry: Wall Paneling%';
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name LIKE 'Insulation:%';
UPDATE product_catalog SET quantity_mode = 'sqft' WHERE name LIKE 'Masonry:%';
