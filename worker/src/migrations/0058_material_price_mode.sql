-- Add material_price_mode toggle to user_settings
-- When enabled, quote generation will calculate material prices using the
-- predefined formula (base unit price × markup multiplier) instead of using
-- the catalog's unit price directly.

ALTER TABLE user_settings ADD COLUMN material_price_mode INTEGER NOT NULL DEFAULT 0;
