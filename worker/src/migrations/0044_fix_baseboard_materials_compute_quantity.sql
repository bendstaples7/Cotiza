-- Fix cq-materials-baseboard-trim-shoe: was targeting 'Materials: Baseboard Trim and Shoe'
-- but add_line_item rules add 'Materials: Baseboard Supplies'. Correcting the target.

UPDATE rules SET
  condition_json = '{"type":"compound","conditions":[{"type":"line_item_exists","productNamePattern":"Materials: Baseboard Supplies","matchMode":"exact"},{"type":"request_text_extract","pattern":"(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)","variableName":"sqft"}]}',
  action_json = '[{"type":"compute_quantity","productNamePattern":"Materials: Baseboard Supplies","formula":"sqft / 2.5","matchMode":"exact"}]',
  name = 'Compute Baseboard Supplies Linear Feet from Sqft',
  description = 'Sets Materials: Baseboard Supplies quantity to sqft / 2.5 (perimeter linear feet)',
  updated_at = datetime('now')
WHERE id = 'cq-materials-baseboard-trim-shoe';
