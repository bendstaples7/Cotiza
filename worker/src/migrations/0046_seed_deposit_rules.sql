-- Seed the "Quote Terms" rule group and its three built-in rules:
--   1. Default Note Rule       — always fires, sets the permit-fee disclaimer note
--   2. High-Value Deposit Rule — fires when quote total >= $10,000, sets 4-milestone schedule
--   3. Standard Deposit Rule   — always fires, sets the 2-milestone 30%/70% schedule
--
-- All inserts use INSERT OR IGNORE for idempotency (safe to re-run).
-- Stable UUIDs are used so re-runs never create duplicate rows.
--
-- Priority resolution:
--   Default Note Rule (100) and High-Value Deposit Rule (100) act on different fields
--   (customerNote vs depositSchedule) so sharing priorityOrder 100 is intentional.
--   Standard Deposit Rule (200) loses to High-Value Deposit Rule (100) when both fire.
--
-- Requirements: 1.4, 6.4, 7.4

-- ── Rule Group: Quote Terms ───────────────────────────────────────────────
INSERT OR IGNORE INTO rule_groups (id, name, description, display_order)
VALUES (
  'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
  'Quote Terms',
  'Rules that set customer-facing quote terms: permit-fee disclaimer note and deposit payment schedules',
  100
);

-- ── Default Note Rule ─────────────────────────────────────────────────────
-- priorityOrder: 100, condition: always, action: set_customer_note
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6',
  'Default Note Rule',
  'Sets the standard permit-fee disclaimer on every quote',
  'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
  100, 1, 'on_create',
  '{"type":"always"}',
  '[{"type":"set_customer_note","text":"Estimate does not include permit fees, or permit coordination fees. If customer would like permits pulled for this work, will require change order at additional cost."}]',
  datetime('now'), datetime('now')
);

-- ── High-Value Deposit Rule ───────────────────────────────────────────────
-- priorityOrder: 100, condition: quote_total_gte $10,000, action: set_deposit_schedule (4 milestones)
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'c3d4e5f6-a7b8-4c9d-0e1f-a2b3c4d5e6f7',
  'High-Value Deposit Rule',
  'Sets a four-milestone payment schedule for quotes totalling $10,000 or more',
  'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
  100, 1, 'on_create',
  '{"type":"quote_total_gte","threshold":10000}',
  '[{"type":"set_deposit_schedule","schedule":{"label":"High-Value Payment Schedule","milestones":[{"percentage":30,"description":"Deposit due at signing"},{"percentage":30,"description":"Due at completion of rough plumbing and electric"},{"percentage":30,"description":"Due at completion of tile and flooring"},{"percentage":10,"description":"Due at customer sign-off of punch list"}]}}]',
  datetime('now'), datetime('now')
);

-- ── Standard Deposit Rule ─────────────────────────────────────────────────
-- priorityOrder: 200, condition: always, action: set_deposit_schedule (2 milestones, 30% + 70%)
-- Note: two milestones are required so percentages sum to 100 (rules engine invariant).
-- The 70% "Balance due at completion of work" milestone satisfies the sum-to-100 constraint
-- while preserving the intent of a 30% upfront deposit (see design doc conflict resolution note).
INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'd4e5f6a7-b8c9-4d0e-1f2a-b3c4d5e6f7a8',
  'Standard Deposit Rule',
  'Sets a standard two-milestone 30%/70% deposit schedule on every quote',
  'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
  200, 1, 'on_create',
  '{"type":"always"}',
  '[{"type":"set_deposit_schedule","schedule":{"label":"Standard Deposit","milestones":[{"percentage":30,"description":"Deposit due at signing"},{"percentage":70,"description":"Balance due at completion of work"}]}}]',
  datetime('now'), datetime('now')
);
