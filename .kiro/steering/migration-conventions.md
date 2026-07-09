---
inclusion: fileMatch
fileMatchPattern: "worker/src/migrations/*.sql"
---

# D1 Migration Conventions

## Why This Matters

A non-idempotent migration will block the entire deploy pipeline. If a migration fails, the worker deploy is skipped, but the client (Pages) may still deploy — creating a version mismatch where the UI references features the backend can't serve. This has caused production outages.

## Required Patterns

### CREATE TABLE — always use IF NOT EXISTS

```sql
-- ✅ Good
CREATE TABLE IF NOT EXISTS my_table ( ... );

-- ❌ Bad — fails if table already exists
CREATE TABLE my_table ( ... );
```

### CREATE INDEX — always use IF NOT EXISTS

```sql
-- ✅ Good
CREATE INDEX IF NOT EXISTS idx_name ON my_table(col);

-- ❌ Bad
CREATE INDEX idx_name ON my_table(col);
```

### ALTER TABLE ADD COLUMN — mark with IDEMPOTENCY comment

SQLite does not support `ADD COLUMN IF NOT EXISTS`. If the column already exists, the statement fails and blocks the migration pipeline.

Every `ALTER TABLE ... ADD COLUMN` must have an `IDEMPOTENCY:` marker comment on the line immediately above it:

```sql
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE my_table ADD COLUMN new_col TEXT DEFAULT NULL;
```

This marker:
1. Signals to the CI validation script that the author is aware of the risk
2. Tells the deploy operator that this migration may need manual intervention if partially applied

### DROP TABLE / DROP COLUMN — avoid in migrations

Prefer soft-deletes or leaving unused columns in place. If you must drop, add a comment explaining why and ensure no deployed code references the dropped object.

### Never edit an already-applied migration

D1 tracks applied migrations by **filename**. Once a migration has run in production, editing that file does **not** re-apply it. New schema changes must always be a **new** numbered `00NN_*.sql` file.

```sql
-- ✅ Good — forward migration for a table missing in production
-- worker/src/migrations/0067_oauth_states.sql
CREATE TABLE IF NOT EXISTS oauth_states ( ... );

-- ❌ Bad — adding a table to 0001_initial_schema.sql after 0001 was already applied
```

CI blocks PRs that modify or delete existing files under `worker/src/migrations/`.

## CI Enforcement

The `worker/scripts/validate-migrations.sh` script runs in CI on every PR. It checks:
- `CREATE TABLE` has `IF NOT EXISTS`
- `CREATE INDEX` has `IF NOT EXISTS`
- `ALTER TABLE ADD COLUMN` has an `IDEMPOTENCY:` marker comment
- Existing migration files are not modified or deleted (immutable migrations)

Migrations that fail these checks will block the PR.

Post-deploy, `/health/pipelines` includes a `d1` probe that verifies required tables exist in production (see `worker/src/required-d1-tables.ts`).
