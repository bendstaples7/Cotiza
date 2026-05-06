-- Add baseboard_rate and crown_molding_rate to productivity_rates.
-- 60 LF/hr for baseboard, 40 LF/hr for crown molding (more complex).
-- Updates compute_quantity rules to produce hours: sqft / 2.5 / rate

INSERT OR IGNORE INTO productivity_rates (id, variable_name, display_name, sqft_per_hour, description, created_at, updated_at)
VALUES ('pr-baseboard', 'baseboard_rate', 'Baseboard & Trim Installation', 60, 'Linear feet of baseboard/trim a crew can install per hour', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO productivity_rates (id, variable_name, display_name, sqft_per_hour, description, created_at, updated_at)
VALUES ('pr-crown-molding', 'crown_molding_rate', 'Crown Molding Installation', 40, 'Linear feet of crown molding a crew can install per hour', datetime('now'), datetime('now'));

UPDATE rules SET action_json = '[{"type":"compute_quantity","productNamePattern":"Carpentry: Install Baseboard Trim","formula":"sqft / 2.5 / baseboard_rate","matchMode":"exact"}]', updated_at = datetime('now') WHERE id = 'cq-baseboard-trim';

UPDATE rules SET action_json = '[{"type":"compute_quantity","productNamePattern":"Carpentry: Install Baseboard Shoe","formula":"sqft / 2.5 / baseboard_rate","matchMode":"exact"}]', updated_at = datetime('now') WHERE id = 'cq-baseboard-shoe';

UPDATE rules SET action_json = '[{"type":"compute_quantity","productNamePattern":"Carpentry: Install Baseboard Trim and Shoe","formula":"sqft / 2.5 / baseboard_rate","matchMode":"exact"}]', updated_at = datetime('now') WHERE id = 'cq-baseboard-trim-and-shoe';

UPDATE rules SET action_json = '[{"type":"compute_quantity","productNamePattern":"Carpentry: Crown Molding Installation","formula":"sqft / 2.5 / crown_molding_rate","matchMode":"exact"}]', updated_at = datetime('now') WHERE id = 'cq-crown-molding';
