#!/usr/bin/env bash
# validate-migrations.sh
#
# Validates that all D1 migrations follow idempotency conventions.
# Catches patterns that could block the deploy pipeline if a migration
# is partially applied or re-run.
#
# Usage: bash worker/scripts/validate-migrations.sh

set -euo pipefail

MIGRATIONS_DIR="worker/src/migrations"
ERRORS=0

echo "=== Migration Pattern Validation ==="
echo ""

for file in "$MIGRATIONS_DIR"/*.sql; do
  filename=$(basename "$file")

  # Check each ALTER TABLE ... ADD COLUMN has an IDEMPOTENCY marker on the
  # same line or the immediately preceding line. A single marker anywhere
  # in the file is not sufficient — each statement needs its own.
  while IFS= read -r line_info; do
    lineno=$(echo "$line_info" | cut -d: -f1)
    prev=$((lineno - 1))
    # Check if the ALTER line itself or the line above contains the marker
    marker_found=false
    if sed -n "${lineno}p" "$file" | grep -q 'IDEMPOTENCY:'; then
      marker_found=true
    elif [ "$prev" -ge 1 ] && sed -n "${prev}p" "$file" | grep -q 'IDEMPOTENCY:'; then
      marker_found=true
    fi
    if [ "$marker_found" = false ]; then
      echo "❌ $filename:$lineno: ALTER TABLE ADD COLUMN without IDEMPOTENCY marker."
      echo "   SQLite cannot do ADD COLUMN IF NOT EXISTS."
      echo "   Add a comment on the preceding line: -- IDEMPOTENCY: column may already exist"
      echo ""
      ERRORS=$((ERRORS + 1))
    fi
  done < <(grep -niP 'ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN' "$file" || true)

  # Check for CREATE TABLE without IF NOT EXISTS
  if grep -iqP 'CREATE\s+TABLE\s+(?!IF)' "$file"; then
    echo "❌ $filename: CREATE TABLE without IF NOT EXISTS."
    echo ""
    ERRORS=$((ERRORS + 1))
  fi

  # Check for CREATE INDEX (including CREATE UNIQUE INDEX) without IF NOT EXISTS
  if grep -iqP 'CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF)' "$file"; then
    echo "❌ $filename: CREATE INDEX without IF NOT EXISTS."
    echo ""
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""
echo "=== Immutable Migrations Check ==="
echo ""

# Schema changes must be additive: new numbered files only. Editing an already-applied
# migration (e.g. 0001_initial_schema.sql) does not re-run on production D1.
IMMUTABLE_BASE="${IMMUTABLE_MIGRATIONS_BASE:-origin/main}"
if git rev-parse --verify "$IMMUTABLE_BASE" >/dev/null 2>&1; then
  set +e
  MODIFIED_MIGRATIONS=$(git diff --name-only --diff-filter=MDR "$IMMUTABLE_BASE"...HEAD -- "$MIGRATIONS_DIR" 2>/dev/null)
  DIFF_EXIT=$?
  set -e
  if [ "$DIFF_EXIT" -gt 1 ]; then
    echo "❌ git diff failed (exit $DIFF_EXIT) — cannot verify immutable migrations."
    echo ""
    ERRORS=$((ERRORS + 1))
  elif [ -n "$MODIFIED_MIGRATIONS" ]; then
    echo "❌ Modified or deleted migration files detected (only new *.sql files are allowed):"
    echo "$MODIFIED_MIGRATIONS" | sed 's/^/   /'
    echo ""
    echo "   Schema changes to production must use a new numbered migration file,"
    echo "   not edits to an existing one. D1 will not re-apply changed files."
    echo ""
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ No edits to existing migration files since $IMMUTABLE_BASE"
  fi
else
  echo "⚠️  Skipping immutable check ($IMMUTABLE_BASE not found — run git fetch origin)"
fi

if [ "$ERRORS" -gt 0 ]; then
  echo "=== ❌ $ERRORS migration issue(s) found ==="
  echo "See .kiro/steering/migration-conventions.md for required patterns."
  exit 1
else
  echo "=== ✅ All migrations pass pattern validation ==="
fi
