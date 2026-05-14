-- Add scope_constraint column to rules table.
-- When set, a rule only fires when the detected scopes from the customer request
-- include this value (e.g. 'wall', 'ceiling', 'floor').
-- This prevents rules like "Include Painting and Carpentry with Drywall Quote"
-- from firing unconditionally on ceiling-only drywall requests.

-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE rules ADD COLUMN scope_constraint TEXT DEFAULT NULL;
