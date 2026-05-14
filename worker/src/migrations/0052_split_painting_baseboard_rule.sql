-- Split the "Include Painting and Carpentry with Drywall Quote" rule so that:
--   - Interior Painting and Paint Supplies fire for ALL drywall (no scope constraint)
--   - Carpentry: Install Baseboard Trim and Shoe only fires for WALL drywall
--
-- Uses the new per-action scopeConstraint field (Option 2) on the baseboard action,
-- and clears the rule-level scope_constraint (Option 1) so painting is no longer
-- blocked for ceiling-only drywall requests.

UPDATE rules
SET
  scope_constraint = NULL,
  action_json = '[{"type":"add_line_item","productName":"Interior Painting","quantity":1,"unitPrice":100,"placeAfter":"Drywall: Installation of New Drywall"},{"type":"add_line_item","productName":"Materials: Paint Supplies","quantity":1,"unitPrice":100,"placeAfter":"Interior Painting"},{"type":"add_line_item","productName":"Carpentry: Install Baseboard Trim and Shoe","quantity":1,"unitPrice":100,"placeAfter":"Materials: Paint Supplies","scopeConstraint":"wall"}]',
  updated_at = datetime('now')
WHERE name LIKE 'Include Painting and Carpentry with Drywall Quote%';
