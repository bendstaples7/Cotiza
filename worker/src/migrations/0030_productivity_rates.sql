-- Migration: 0030_productivity_rates.sql
-- Creates the global productivity_rates table and seeds 6 initial rates.
-- Rates represent sqft-per-hour values for trade-specific labor categories.
-- Used by QuoteEngine to inject rate variables into preResolvedContext so
-- compute_quantity formulas like `sqft / drywall_rate` resolve correctly.

CREATE TABLE IF NOT EXISTS productivity_rates (
  id            TEXT PRIMARY KEY,
  variable_name TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  sqft_per_hour REAL NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_productivity_rates_variable_name
  ON productivity_rates(variable_name);

-- Seed initial rates using INSERT OR IGNORE for idempotency.
-- Flooring items (quantity = sqft * 1) are intentionally excluded —
-- their compute_quantity formula does not require a rate variable.
INSERT OR IGNORE INTO productivity_rates (id, variable_name, display_name, sqft_per_hour, description)
VALUES
  ('pr-drywall',
   'drywall_rate',
   'Drywall: Installation of New Drywall',
   40,
   'Square feet of new drywall a crew can install per hour'),
  ('pr-paint',
   'paint_rate',
   'Interior Painting',
   100,
   'Square feet of interior wall a crew can paint per hour'),
  ('pr-paint-ceiling',
   'paint_ceiling_rate',
   'Interior Painting: Ceilings',
   80,
   'Square feet of ceiling a crew can paint per hour'),
  ('pr-tile-shower',
   'tile_shower_rate',
   'Tile: Install Tiled Shower Surround',
   8,
   'Square feet of shower surround tile a crew can install per hour'),
  ('pr-tile-floor',
   'tile_floor_rate',
   'Tile: Install and Grout New Tile Floor',
   12,
   'Square feet of floor tile a crew can install and grout per hour'),
  ('pr-tile-bath',
   'tile_bath_rate',
   'Tile: Bath Surround',
   8,
   'Square feet of bath surround tile a crew can install per hour');
