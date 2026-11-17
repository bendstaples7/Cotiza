-- Migration: 0084_trade_specific_deposit_milestones.sql
-- Ben's rule (2026-11-17): milestones must match the quote. The High-Value Deposit
-- Rule's middle milestones become {{early}} / {{late}} placeholders the rules engine
-- fills from the quote's line items in renovation order. Idempotent single UPDATE.

UPDATE rules
SET action_json = '[{"type":"set_deposit_schedule","schedule":{"label":"High-Value Payment Schedule","milestones":[{"percentage":30,"description":"Deposit due at signing"},{"percentage":30,"description":"{{early}}"},{"percentage":30,"description":"{{late}}"},{"percentage":10,"description":"Due at customer sign-off of punch list"}]}}]',
    updated_at = datetime('now')
WHERE id = 'c3d4e5f6-a7b8-4c9d-0e1f-a2b3c4d5e6f7';
