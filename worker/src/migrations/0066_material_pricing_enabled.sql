-- Add material_pricing_enabled toggle to user_settings
-- When enabled (default), material line items with calculated prices are
-- automatically added during quote generation. When disabled, material
-- add_line_item rules are filtered out so materials don't auto-appear.
-- This is a margin opportunity: calculated material prices include
-- Chicago retail + IL/ Cook County sales tax + 20% margin.

-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE user_settings ADD COLUMN material_pricing_enabled INTEGER NOT NULL DEFAULT 1;