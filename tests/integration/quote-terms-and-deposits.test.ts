/**
 * Integration Tests — Quote Terms and Deposits
 *
 * Tests end-to-end quote generation using executeRules directly with the
 * three built-in rules seeded by migration 0046_seed_deposit_rules.sql.
 *
 * These tests construct the StructuredRule objects to match the seeded data
 * exactly and call executeRules with appropriate line items to verify that
 * the correct customerNote and depositSchedule are produced.
 *
 * Requirements: 1.1, 6.1, 6.2, 6.3, 7.2, 7.3
 */

import { describe, it, expect } from 'vitest';
import { executeRules } from '../../worker/src/services/rules-engine.js';
import type { StructuredRule, EngineLineItem } from '../../shared/src/types/quote.js';

// ═══════════════════════════════════════════════════════════════════════════
// Built-in rules — matching migration 0046_seed_deposit_rules.sql exactly
// ═══════════════════════════════════════════════════════════════════════════

const PERMIT_FEE_DISCLAIMER =
  'Estimate does not include permit fees, or permit coordination fees. If customer would like permits pulled for this work, will require change order at additional cost.';

/** Default Note Rule — priorityOrder: 100, always, set_customer_note */
const DEFAULT_NOTE_RULE: StructuredRule = {
  id: 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6',
  name: 'Default Note Rule',
  priorityOrder: 100,
  triggerMode: 'on_create',
  condition: { type: 'always' },
  actions: [
    {
      type: 'set_customer_note',
      text: PERMIT_FEE_DISCLAIMER,
    },
  ],
};

/** High-Value Deposit Rule — priorityOrder: 100, quote_total_gte 10000, set_deposit_schedule */
const HIGH_VALUE_DEPOSIT_RULE: StructuredRule = {
  id: 'c3d4e5f6-a7b8-4c9d-0e1f-a2b3c4d5e6f7',
  name: 'High-Value Deposit Rule',
  priorityOrder: 100,
  triggerMode: 'on_create',
  condition: { type: 'quote_total_gte', threshold: 10000 },
  actions: [
    {
      type: 'set_deposit_schedule',
      schedule: {
        label: 'High-Value Payment Schedule',
        milestones: [
          { percentage: 30, description: 'Deposit due at signing' },
          { percentage: 30, description: 'Due at completion of rough plumbing and electric' },
          { percentage: 30, description: 'Due at completion of tile and flooring' },
          { percentage: 10, description: 'Due at customer sign-off of punch list' },
        ],
      },
    },
  ],
};

/** Standard Deposit Rule — priorityOrder: 200, always, set_deposit_schedule */
const STANDARD_DEPOSIT_RULE: StructuredRule = {
  id: 'd4e5f6a7-b8c9-4d0e-1f2a-b3c4d5e6f7a8',
  name: 'Standard Deposit Rule',
  priorityOrder: 200,
  triggerMode: 'on_create',
  condition: { type: 'always' },
  actions: [
    {
      type: 'set_deposit_schedule',
      schedule: {
        label: 'Standard Deposit',
        milestones: [
          { percentage: 30, description: 'Deposit due at signing' },
          { percentage: 70, description: 'Balance due at completion of work' },
        ],
      },
    },
  ],
};

/** All three built-in rules as seeded by migration 0046 */
const ALL_SEEDED_RULES: StructuredRule[] = [
  DEFAULT_NOTE_RULE,
  HIGH_VALUE_DEPOSIT_RULE,
  STANDARD_DEPOSIT_RULE,
];

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeLineItem(id: string, quantity: number, unitPrice: number): EngineLineItem {
  return {
    id,
    productCatalogEntryId: null,
    productName: `Product ${id}`,
    description: '',
    quantity,
    unitPrice,
    confidenceScore: 100,
    originalText: '',
    ruleIdsApplied: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: Quote under $10,000 — Standard Deposit + permit-fee disclaimer
//
// With all three built-in rules seeded:
//   - Default Note Rule (priority 100, always) → sets customerNote
//   - High-Value Deposit Rule (priority 100, quote_total_gte 10000) → does NOT fire
//   - Standard Deposit Rule (priority 200, always) → sets depositSchedule
//
// Expected:
//   - customerNote = permit-fee disclaimer
//   - depositSchedule.label = "Standard Deposit"
//   - depositSchedule.milestones = [30%, 70%]
//
// Requirements: 1.1, 6.1
// ═══════════════════════════════════════════════════════════════════════════

describe('Quote under $10,000 with all three built-in rules seeded', () => {
  const lineItems = [makeLineItem('li-1', 1, 5000)]; // total = $5,000

  it('customerNote equals the permit-fee disclaimer', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    expect(result.customerNote).toBe(PERMIT_FEE_DISCLAIMER);
  });

  it('depositSchedule label is "Standard Deposit"', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    expect(result.depositSchedule).not.toBeNull();
    expect(result.depositSchedule!.label).toBe('Standard Deposit');
  });

  it('depositSchedule has exactly two milestones (30% + 70%)', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    const milestones = result.depositSchedule!.milestones;
    expect(milestones).toHaveLength(2);
    expect(milestones[0].percentage).toBe(30);
    expect(milestones[0].description).toBe('Deposit due at signing');
    expect(milestones[1].percentage).toBe(70);
    expect(milestones[1].description).toBe('Balance due at completion of work');
  });

  it('depositSchedule milestone percentages sum to 100', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    const sum = result.depositSchedule!.milestones.reduce((acc, m) => acc + m.percentage, 0);
    expect(sum).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Quote over $10,000 — High-Value Payment Schedule wins
//
// With all three built-in rules seeded:
//   - Default Note Rule (priority 100, always) → sets customerNote
//   - High-Value Deposit Rule (priority 100, quote_total_gte 10000) → fires, sets depositSchedule
//   - Standard Deposit Rule (priority 200, always) → fires but loses (priority 200 > 100)
//
// Priority resolution for set_deposit_schedule: lowest priorityOrder wins.
// High-Value (100) beats Standard (200).
//
// Expected:
//   - depositSchedule.label = "High-Value Payment Schedule"
//   - depositSchedule.milestones = [30%, 30%, 30%, 10%]
//
// Requirements: 6.2, 6.3, 7.2, 7.3
// ═══════════════════════════════════════════════════════════════════════════

describe('Quote over $10,000 with all three built-in rules seeded', () => {
  const lineItems = [makeLineItem('li-1', 1, 15000)]; // total = $15,000

  it('depositSchedule label is "High-Value Payment Schedule"', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    expect(result.depositSchedule).not.toBeNull();
    expect(result.depositSchedule!.label).toBe('High-Value Payment Schedule');
  });

  it('depositSchedule has exactly four milestones (30%/30%/30%/10%)', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    const milestones = result.depositSchedule!.milestones;
    expect(milestones).toHaveLength(4);
    expect(milestones[0].percentage).toBe(30);
    expect(milestones[0].description).toBe('Deposit due at signing');
    expect(milestones[1].percentage).toBe(30);
    expect(milestones[1].description).toBe('Due at completion of rough plumbing and electric');
    expect(milestones[2].percentage).toBe(30);
    expect(milestones[2].description).toBe('Due at completion of tile and flooring');
    expect(milestones[3].percentage).toBe(10);
    expect(milestones[3].description).toBe('Due at customer sign-off of punch list');
  });

  it('depositSchedule milestone percentages sum to 100', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    const sum = result.depositSchedule!.milestones.reduce((acc, m) => acc + m.percentage, 0);
    expect(sum).toBe(100);
  });

  it('customerNote still equals the permit-fee disclaimer', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    expect(result.customerNote).toBe(PERMIT_FEE_DISCLAIMER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: Boundary — Quote at exactly $10,000 triggers High-Value rule
//
// The quote_total_gte condition fires when total >= threshold.
// A quote totalling exactly $10,000 should use the High-Value schedule.
//
// Requirements: 7.1, 7.2
// ═══════════════════════════════════════════════════════════════════════════

describe('Quote at exactly $10,000 boundary', () => {
  const lineItems = [makeLineItem('li-1', 1, 10000)]; // total = $10,000 exactly

  it('depositSchedule is the High-Value Payment Schedule at the exact threshold', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    expect(result.depositSchedule).not.toBeNull();
    expect(result.depositSchedule!.label).toBe('High-Value Payment Schedule');
    expect(result.depositSchedule!.milestones).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: Quote just below $10,000 uses Standard Deposit
//
// A quote totalling $9,999.99 should use the Standard Deposit schedule.
//
// Requirements: 6.1, 7.1
// ═══════════════════════════════════════════════════════════════════════════

describe('Quote just below $10,000 boundary', () => {
  const lineItems = [makeLineItem('li-1', 1, 9999.99)]; // total = $9,999.99

  it('depositSchedule is the Standard Deposit just below the threshold', () => {
    const result = executeRules({
      lineItems,
      rules: ALL_SEEDED_RULES,
      catalog: [],
    });

    expect(result.depositSchedule).not.toBeNull();
    expect(result.depositSchedule!.label).toBe('Standard Deposit');
    expect(result.depositSchedule!.milestones).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// API Integration Tests — QuoteDraftService (service layer)
//
// These tests exercise the service layer directly using the mock D1 helper,
// mirroring what the API routes do when handling HTTP requests.
//
// Since there is no running HTTP server in tests, QuoteDraftService.update()
// and QuoteDraftService.getById() are called directly — the same code paths
// that the PUT /api/quotes/drafts/:id and GET /api/quotes/drafts/:id route
// handlers invoke.
//
// Requirements: 4.1, 4.3, 4.5
// ═══════════════════════════════════════════════════════════════════════════

import { beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createMockD1, configurePrepareResults } from '../unit/helpers/mock-d1.js';
import type { MockD1Database } from '../unit/helpers/mock-d1.js';
import { QuoteDraftService } from '../../worker/src/services/quote-draft-service.js';
import { PlatformError } from '../../worker/src/errors/index.js';
import type { DepositSchedule } from 'shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid D1 row for a quote_drafts record */
function makeApiDraftRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'draft-api-001',
    user_id: 'user-api',
    customer_request_text: 'Replace kitchen tile',
    selected_template_id: null,
    selected_template_name: null,
    status: 'draft',
    jobber_request_id: null,
    customer_note: null,
    manual_request_id: null,
    draft_number: 1,
    jobber_quote_id: null,
    jobber_quote_number: null,
    jobber_quote_web_uri: null,
    sqft_resolution_json: null,
    deposit_schedule: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Configure mock DB for a QuoteDraftService.update() call.
 *
 * update() issues these prepare() calls in order:
 *   1. getById() ownership check:
 *      a. first()  — quote_drafts row
 *      b. all()    — quote_line_items rows
 *      c. all()    — action_items rows
 *   2. UPDATE statement (prepared, then passed to batch())
 *   3. Re-read after update:
 *      a. first()  — quote_drafts row (updated)
 *      b. all()    — quote_line_items rows
 *      c. all()    — action_items rows
 */
function configureUpdateCall(
  db: MockD1Database,
  initialRow: Record<string, unknown>,
  updatedRow: Record<string, unknown>,
): void {
  configurePrepareResults(db, [
    // getById() ownership check
    { first: initialRow },
    { all: { results: [] } },
    { all: { results: [] } },
    // UPDATE statement (prepared and passed to batch)
    { run: { success: true, meta: {} } },
    // Re-read after update
    { first: updatedRow },
    { all: { results: [] } },
    { all: { results: [] } },
  ]);
}

/**
 * Configure mock DB for a QuoteDraftService.getById() call.
 *
 * getById() issues three sequential prepare() calls:
 *   1. first()  — the quote_drafts row
 *   2. all()    — quote_line_items rows
 *   3. all()    — action_items rows
 */
function configureGetByIdCall(
  db: MockD1Database,
  draftRow: Record<string, unknown>,
): void {
  configurePrepareResults(db, [
    { first: draftRow },
    { all: { results: [] } },
    { all: { results: [] } },
  ]);
}

// ---------------------------------------------------------------------------
// Tests — PUT /api/quotes/drafts/:id (via QuoteDraftService.update)
// Requirements: 4.1, 4.5
// ---------------------------------------------------------------------------

describe('API integration — PUT /api/quotes/drafts/:id with valid depositSchedule', () => {
  let db: MockD1Database;
  let service: QuoteDraftService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    service = new QuoteDraftService(db as unknown as D1Database);
  });

  it('returns updated draft containing the schedule when depositSchedule is valid (two milestones)', async () => {
    // Requirement 4.1: PUT with valid depositSchedule → 200 with updated draft containing the schedule
    const validSchedule: DepositSchedule = {
      label: 'Standard Deposit',
      milestones: [
        { description: 'Deposit due at signing', percentage: 30 },
        { description: 'Balance due at completion of work', percentage: 70 },
      ],
    };

    const updatedRow = makeApiDraftRow({
      deposit_schedule: JSON.stringify(validSchedule),
    });

    configureUpdateCall(db, makeApiDraftRow(), updatedRow);

    const result = await service.update('draft-api-001', 'user-api', {
      depositSchedule: validSchedule,
    });

    expect(result.depositSchedule).not.toBeNull();
    expect(result.depositSchedule!.label).toBe('Standard Deposit');
    expect(result.depositSchedule!.milestones).toHaveLength(2);
    expect(result.depositSchedule!.milestones[0]).toEqual({
      description: 'Deposit due at signing',
      percentage: 30,
    });
    expect(result.depositSchedule!.milestones[1]).toEqual({
      description: 'Balance due at completion of work',
      percentage: 70,
    });
  });

  it('returns updated draft containing the schedule when depositSchedule is valid (four milestones)', async () => {
    // Requirement 4.1: valid multi-milestone schedule is accepted and returned
    const highValueSchedule: DepositSchedule = {
      label: 'High-Value Payment Schedule',
      milestones: [
        { description: 'Deposit due at signing', percentage: 30 },
        { description: 'Due at completion of rough plumbing and electric', percentage: 30 },
        { description: 'Due at completion of tile and flooring', percentage: 30 },
        { description: 'Due at customer sign-off of punch list', percentage: 10 },
      ],
    };

    const updatedRow = makeApiDraftRow({
      deposit_schedule: JSON.stringify(highValueSchedule),
    });

    configureUpdateCall(db, makeApiDraftRow(), updatedRow);

    const result = await service.update('draft-api-001', 'user-api', {
      depositSchedule: highValueSchedule,
    });

    expect(result.depositSchedule).not.toBeNull();
    expect(result.depositSchedule!.label).toBe('High-Value Payment Schedule');
    expect(result.depositSchedule!.milestones).toHaveLength(4);
    const sum = result.depositSchedule!.milestones.reduce((acc, m) => acc + m.percentage, 0);
    expect(sum).toBe(100);
  });
});

describe('API integration — PUT /api/quotes/drafts/:id with invalid depositSchedule (sum ≠ 100)', () => {
  let db: MockD1Database;
  let service: QuoteDraftService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    service = new QuoteDraftService(db as unknown as D1Database);
  });

  it('throws PlatformError when milestone percentages do not sum to 100', async () => {
    // Requirement 4.5: invalid depositSchedule (sum ≠ 100) → error thrown
    const invalidSchedule: DepositSchedule = {
      label: 'Bad Schedule',
      milestones: [
        { description: 'First payment', percentage: 30 },
        { description: 'Second payment', percentage: 50 },
        // Total: 80 — does not sum to 100
      ],
    };

    // getById() is called first for ownership check before validation
    configurePrepareResults(db, [
      { first: makeApiDraftRow() },
      { all: { results: [] } },
      { all: { results: [] } },
    ]);

    await expect(
      service.update('draft-api-001', 'user-api', { depositSchedule: invalidSchedule }),
    ).rejects.toThrow(PlatformError);
  });

  it('error description mentions percentages summing to 100 when sum ≠ 100', async () => {
    // Requirement 4.5: error message must state percentages must sum to 100
    const invalidSchedule: DepositSchedule = {
      label: 'Bad Schedule',
      milestones: [
        { description: 'First payment', percentage: 40 },
        { description: 'Second payment', percentage: 40 },
        // Total: 80 — does not sum to 100
      ],
    };

    configurePrepareResults(db, [
      { first: makeApiDraftRow() },
      { all: { results: [] } },
      { all: { results: [] } },
    ]);

    let caughtError: PlatformError | undefined;
    try {
      await service.update('draft-api-001', 'user-api', { depositSchedule: invalidSchedule });
    } catch (err) {
      if (err instanceof PlatformError) {
        caughtError = err;
      }
    }

    expect(caughtError).toBeDefined();
    // The error description should mention percentages summing to 100
    expect(caughtError!.description).toMatch(/sum.*100|100.*sum/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — GET /api/quotes/drafts/:id (via QuoteDraftService.getById)
// Requirements: 4.3
// ---------------------------------------------------------------------------

describe('API integration — GET /api/quotes/drafts/:id includes depositSchedule field', () => {
  let db: MockD1Database;
  let service: QuoteDraftService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    service = new QuoteDraftService(db as unknown as D1Database);
  });

  it('response includes depositSchedule field as null when not set', async () => {
    // Requirement 4.3: GET response includes depositSchedule field (null when not set)
    configureGetByIdCall(db, makeApiDraftRow({ deposit_schedule: null }));

    const draft = await service.getById('draft-api-001', 'user-api');

    // depositSchedule must be present on the returned object and be null
    expect(draft).toHaveProperty('depositSchedule');
    expect(draft.depositSchedule).toBeNull();
  });

  it('response includes depositSchedule field with schedule data when set', async () => {
    // Requirement 4.3: GET response includes depositSchedule when it has been assigned
    const schedule: DepositSchedule = {
      label: 'Standard Deposit',
      milestones: [
        { description: 'Deposit due at signing', percentage: 30 },
        { description: 'Balance due at completion of work', percentage: 70 },
      ],
    };

    configureGetByIdCall(db, makeApiDraftRow({ deposit_schedule: JSON.stringify(schedule) }));

    const draft = await service.getById('draft-api-001', 'user-api');

    expect(draft).toHaveProperty('depositSchedule');
    expect(draft.depositSchedule).toEqual(schedule);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: Migration safety — 0045_deposit_schedule.sql content validation
//
// Since there is no real SQLite instance in the test environment, this test
// validates the migration file content directly. It verifies:
//   1. The migration contains the correct ALTER TABLE statement
//   2. The IDEMPOTENCY: marker comment is present (workspace convention)
//   3. The column is added with DEFAULT NULL (non-destructive)
//
// A non-destructive ALTER TABLE ADD COLUMN with DEFAULT NULL means:
//   - Existing rows receive NULL without a table rewrite
//   - Row count is unchanged
//   - All non-deposit_schedule column values are unaffected
//
// Requirements: 3.1, 3.2, 3.3
// ═══════════════════════════════════════════════════════════════════════════

describe('Migration safety — 0045_deposit_schedule.sql content validation', () => {
  const migrationPath = join(
    process.cwd(),
    'worker',
    'src',
    'migrations',
    '0045_deposit_schedule.sql',
  );

  let migrationSql: string;

  beforeEach(() => {
    migrationSql = readFileSync(migrationPath, 'utf-8');
  });

  it('contains the correct ALTER TABLE statement targeting quote_drafts', () => {
    // Requirement 3.1: migration adds deposit_schedule column to quote_drafts
    expect(migrationSql).toMatch(
      /ALTER\s+TABLE\s+quote_drafts\s+ADD\s+COLUMN\s+deposit_schedule\s+TEXT/i,
    );
  });

  it('specifies DEFAULT NULL so existing rows receive NULL without a table rewrite', () => {
    // Requirement 3.2: non-destructive — existing rows get NULL, row count unchanged
    // SQLite ALTER TABLE ADD COLUMN with DEFAULT NULL does not rewrite the table,
    // so all pre-existing rows implicitly have NULL for the new column.
    expect(migrationSql).toMatch(/DEFAULT\s+NULL/i);
  });

  it('has the IDEMPOTENCY: marker comment required by workspace migration conventions', () => {
    // Requirement 3.3: migration is safe to apply to a database that may already
    // have the column (operator can skip manually if partially applied).
    // The IDEMPOTENCY: marker is required by the CI validation script.
    expect(migrationSql).toContain('IDEMPOTENCY:');
  });

  it('does not contain DROP TABLE or DROP COLUMN statements', () => {
    // Requirement 3.2: migration must be non-destructive — no rows or columns removed
    expect(migrationSql).not.toMatch(/DROP\s+TABLE/i);
    expect(migrationSql).not.toMatch(/DROP\s+COLUMN/i);
  });

  it('does not contain CREATE TABLE (migration only adds a column, not a new table)', () => {
    // Sanity check: this migration should only alter an existing table
    expect(migrationSql).not.toMatch(/CREATE\s+TABLE/i);
  });
});
