-- Scope-aware rules: fix the "Include Painting and Carpentry with Drywall Quote"
-- rule so it only fires for wall drywall requests, not ceiling-only requests.
--
-- Option 3: Set scope_constraint = 'wall' on the problematic rule so the rules
-- engine pre-filter skips it when only ceiling scope is detected.
--
-- Option 2: Add a safety-net "Remove Baseboard When Ceiling-Only Drywall" rule
-- using the new request_text_not_contains condition type.

-- Set scope_constraint = 'wall' on the drywall painting/carpentry rule.
-- The rule name contains a newline so we match by LIKE pattern.
-- This is idempotent: UPDATE on a non-matching name is a no-op.
UPDATE rules
SET scope_constraint = 'wall',
    updated_at = datetime('now')
WHERE name LIKE 'Include Painting and Carpentry with Drywall Quote%';

-- Safety-net rule: remove baseboard trim items when the request mentions ceiling
-- drywall but not wall work. Uses the new request_text_not_contains condition.
-- trigger_mode = 'chained' so it fires after add_line_item rules have run.
INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, condition_json, action_json, trigger_mode, created_at, updated_at)
VALUES (
  'remove-baseboard-ceiling-only',
  'Remove Baseboard When Ceiling-Only Drywall',
  'Removes baseboard trim items when the request mentions ceiling drywall but not wall work',
  (SELECT id FROM rule_groups WHERE name = 'Carpentry' LIMIT 1),
  200,
  1,
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Carpentry: Install Baseboard Trim and Shoe"},{"type":"request_text_contains","substring":"ceiling"},{"type":"request_text_not_contains","substring":"wall"}]}',
  '[{"type":"remove_line_item","productNamePattern":"Carpentry: Install Baseboard Trim and Shoe"},{"type":"remove_line_item","productNamePattern":"Materials: Baseboard Supplies"},{"type":"remove_line_item","productNamePattern":"Materials: Baseboard Trim and Shoe"},{"type":"remove_line_item","productNamePattern":"Materials: Shoe Trim"}]',
  'chained',
  datetime('now'),
  datetime('now')
);
