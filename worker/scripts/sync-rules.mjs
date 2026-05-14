/**
 * Sync business rules between local and production D1.
 *
 * Usage:
 *   node scripts/sync-rules.mjs              # Pull: production → local
 *   node scripts/sync-rules.mjs --push       # Push: local → production
 *   node scripts/sync-rules.mjs --list-remote # List production rules only
 *
 * Gracefully skips if:
 * - Not authenticated with Cloudflare
 * - No network access
 * - No rules in source database
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const listRemoteOnly = process.argv.includes('--list-remote');
const pushToRemote = process.argv.includes('--push');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function runWithFile(flag, sql, extraArgs = '') {
  const tmpFile = join(tmpdir(), `sync-rules-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  try {
    writeFileSync(tmpFile, sql, 'utf8');
    return run(`npx wrangler d1 execute DB ${flag}${extraArgs} --file "${tmpFile}"`);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function query(flag, sql) {
  try {
    // Use --command (not --file) for read queries. With --remote --json,
    // --file leaks progress indicators into stdout and returns upload
    // metadata instead of row data. --command returns clean JSON.
    const output = run(`npx wrangler d1 execute DB ${flag} --json --command "${sql.replace(/"/g, '\\"')}"`);
    const parsed = JSON.parse(output);
    return parsed[0]?.results || [];
  } catch (err) {
    console.debug(`[sync-rules] query failed: ${err.message}`);
    return null;
  }
}

function execFile(flag, sql) {
  runWithFile(flag, sql);
}

/** Escape a string for SQL single-quoted literal. Returns SQL NULL for null/undefined. */
function sqlVal(s) {
  if (s === null || s === undefined) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}

const GROUP_COLUMNS = 'id, name, description, display_order, created_at';
const RULE_COLUMNS = 'id, name, description, rule_group_id, priority_order, is_active, condition_json, action_json, trigger_mode, created_at, updated_at';

/**
 * Build SQL to upsert groups and rules from source into target.
 * When skipLocallyModified=true (pull from production), rules with locally_modified_at
 * set in the local DB are skipped to preserve local migrations and manual edits.
 */
function buildUpsertSql(groups, rules, skipLocallyModified = false) {
  const sqlLines = [];

  // Build a map of local group ID → group name for remapping rule references
  const groupIdToName = new Map();
  for (const g of groups) {
    groupIdToName.set(g.id, g.name);
  }

  for (const g of groups) {
    // Use INSERT OR IGNORE since groups may already exist with different IDs
    // The unique index is on name (case-insensitive), not on id
    sqlLines.push(
      `INSERT OR IGNORE INTO rule_groups (id, name, description, display_order, created_at) VALUES (${sqlVal(g.id)}, ${sqlVal(g.name)}, ${sqlVal(g.description)}, ${g.display_order}, ${sqlVal(g.created_at)});`
    );
    // Update display_order and description for existing groups
    sqlLines.push(
      `UPDATE rule_groups SET description = ${sqlVal(g.description)}, display_order = ${g.display_order} WHERE name = ${sqlVal(g.name)} COLLATE NOCASE;`
    );
  }

  for (const r of rules) {
    // Resolve the rule's group ID to the target DB's group ID by name
    const groupName = groupIdToName.get(r.rule_group_id);
    const groupIdExpr = groupName
      ? `(SELECT id FROM rule_groups WHERE name = ${sqlVal(groupName)} COLLATE NOCASE LIMIT 1)`
      : sqlVal(r.rule_group_id);

    sqlLines.push(
      `INSERT OR IGNORE INTO rules (id, name, description, rule_group_id, priority_order, is_active, condition_json, action_json, trigger_mode, created_at, updated_at) VALUES (${sqlVal(r.id)}, ${sqlVal(r.name)}, ${sqlVal(r.description)}, ${groupIdExpr}, ${r.priority_order}, ${r.is_active}, ${sqlVal(r.condition_json)}, ${sqlVal(r.action_json)}, ${sqlVal(r.trigger_mode)}, ${sqlVal(r.created_at)}, ${sqlVal(r.updated_at)});`
    );
    // Update existing rules (matched by name + group) with latest data.
    // When skipLocallyModified=true (pull from production), skip rules that have been
    // locally modified (locally_modified_at IS NOT NULL) to preserve local migration changes.
    const updateWhere = skipLocallyModified
      ? `WHERE name = ${sqlVal(r.name)} AND rule_group_id = ${groupIdExpr} AND (locally_modified_at IS NULL OR locally_modified_at = 'null')`
      : `WHERE name = ${sqlVal(r.name)} AND rule_group_id = ${groupIdExpr}`;
    sqlLines.push(
      `UPDATE rules SET description = ${sqlVal(r.description)}, priority_order = ${r.priority_order}, is_active = ${r.is_active}, condition_json = ${sqlVal(r.condition_json)}, action_json = ${sqlVal(r.action_json)}, trigger_mode = ${sqlVal(r.trigger_mode)}, updated_at = ${sqlVal(r.updated_at)} ${updateWhere};`
    );
  }

  return sqlLines.join('\n');
}

try {
  if (pushToRemote) {
    // ── Push: local → production ──────────────────────────────
    console.log('[sync-rules] Pushing rules from local → production D1...');

    const localGroups = query('--local', `SELECT ${GROUP_COLUMNS} FROM rule_groups`);
    if (!localGroups) {
      console.error('[sync-rules] Could not read local D1. Aborting.');
      process.exit(1);
    }

    const localRules = query('--local', `SELECT ${RULE_COLUMNS} FROM rules`);
    if (!localRules) {
      console.error('[sync-rules] Could not read local rules. Aborting.');
      process.exit(1);
    }

    console.log(`[sync-rules] Found ${localGroups.length} rule groups and ${localRules.length} rules locally.`);

    for (const r of localRules) {
      const status = r.is_active ? '✅' : '⏸️';
      const structured = (r.condition_json && r.action_json) ? ' [structured]' : ' [legacy]';
      console.log(`  ${status} ${r.name}${structured}`);
    }

    if (localGroups.length === 0 && localRules.length === 0) {
      console.log('[sync-rules] No local rules to push.');
      process.exit(0);
    }

    const sql = buildUpsertSql(localGroups, localRules);
    execFile('--remote', sql);
    console.log(`[sync-rules] Pushed ${localGroups.length} rule groups and ${localRules.length} rules from local → production.`);

  } else {
    // ── Pull: production → local (or list) ────────────────────
    console.log(listRemoteOnly ? '[sync-rules] Listing production rules...' : '[sync-rules] Pulling rules from production D1...');

    const remoteGroups = query('--remote', `SELECT ${GROUP_COLUMNS} FROM rule_groups`);
    if (!remoteGroups) {
      console.log('[sync-rules] Could not reach production D1. Skipping.');
      process.exit(0);
    }

    const remoteRules = query('--remote', `SELECT ${RULE_COLUMNS} FROM rules`);
    if (!remoteRules) {
      if (listRemoteOnly) {
        console.error('[sync-rules] Failed to query rules from production D1.');
        process.exit(1);
      }
      console.log('[sync-rules] Could not query rules from production D1. Skipping.');
      process.exit(0);
    }

    console.log(`[sync-rules] Found ${remoteGroups.length} rule groups and ${remoteRules.length} rules in production.`);

    if (remoteRules.length > 0) {
      for (const r of remoteRules) {
        const status = r.is_active ? '✅' : '⏸️';
        console.log(`  ${status} ${r.name}`);
      }
    }

    if (listRemoteOnly) {
      process.exit(0);
    }

    if (remoteGroups.length === 0 && remoteRules.length === 0) {
      console.log('[sync-rules] No rules in production. Skipping.');
      process.exit(0);
    }

    const sql = buildUpsertSql(remoteGroups, remoteRules, true /* skipLocallyModified */);
    execFile('--local', sql);
    console.log(`[sync-rules] Synced ${remoteGroups.length} rule groups and ${remoteRules.length} rules from production → local.`);
  }

} catch (err) {
  console.log(`[sync-rules] Could not sync rules: ${err.message}. Skipping.`);
  process.exit(0);
}
