-- T5: a drywall patch/repair must not inherit whole-room sqft.
-- 1. Measured patch: "<w> ft wide by <h> ft tall" -> w * h / drywall_rate.
--    Higher priority than cq-drywall-install (20) so it runs last and wins.
-- 2. cq-drywall-install now excludes patch/repair wording, so an unmeasured
--    patch is left at its estimated quantity instead of the whole-room sqft.

INSERT OR IGNORE INTO rules (
  id, name, description, rule_group_id, priority_order, is_active,
  trigger_mode, condition_json, action_json, created_at, updated_at
) VALUES (
  'cq-drywall-patch-measured',
  'Compute Drywall Patch Hours from Measured Area',
  'Sets quantity to (width_ft * height_ft) / drywall_rate for a measured drywall patch',
  (SELECT id FROM rule_groups WHERE name = 'Drywall' LIMIT 1),
  30, 1, 'on_create',
  '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Drywall: Installation of New Drywall","matchMode":"exact"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:ft|feet|foot)\\s*(?:wide|long)","variableName":"drywall_w"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:ft|feet|foot)\\s*(?:tall|high)","variableName":"drywall_h"}]}',
  '[{"type":"compute_quantity","productNamePattern":"Drywall: Installation of New Drywall","formula":"drywall_w * drywall_h / drywall_rate","matchMode":"exact"}]',
  datetime('now'), datetime('now')
);

-- shortcut: any 'patch'/'repair' in the request skips whole-room sqft; upgrade when requests mix new drywall and unrelated repairs.
UPDATE rules
SET condition_json = '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Drywall: Installation of New Drywall","matchMode":"exact"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)","variableName":"sqft"},{"type":"request_text_not_contains","substring":"patch"},{"type":"request_text_not_contains","substring":"repair"}]}',
    updated_at = datetime('now')
WHERE id = 'cq-drywall-install';
