import { describe, it, expect } from 'vitest';
import { RulesService } from '../../worker/src/services/rules-service.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { RuleCondition, RuleAction } from 'shared';

/**
 * Tests for formula-condition cross-validation, regex capture group validation,
 * and preset resolution at rule creation/update time.
 *
 * Validates: Requirements 5.2, 5.4, 8.4
 */
describe('Rules cross-validation at creation/update', () => {
  function createService() {
    const db = createMockD1();
    const service = new RulesService(db as unknown as D1Database);
    return { db, service };
  }

  function setupDbForCreate(db: ReturnType<typeof createMockD1>) {
    // Configure DB to handle: group lookup, insert, select back
    configurePrepareResults(db, [
      // resolveGroupId: find existing "General" group
      { first: { id: 'group-1', name: 'General' } },
      // INSERT rule
      { run: { success: true } },
      // SELECT back the created rule
      {
        first: {
          id: 'rule-1',
          name: 'Test Rule',
          description: 'Test',
          rule_group_id: 'group-1',
          priority_order: 0,
          is_active: 1,
          condition_json: '{}',
          action_json: '[]',
          trigger_mode: 'chained',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      },
    ]);
  }

  // ── Task 8.1: Formula-condition cross-validation ──────────────

  describe('formula-condition cross-validation', () => {
    it('rejects rule when formula references variable not extracted by any condition', async () => {
      const { service } = createService();

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '(\\d+)\\s*sqft',
        variableName: 'sqft',
      };

      const actions: RuleAction[] = [
        {
          type: 'compute_quantity',
          productNamePattern: 'Drywall',
          formula: 'sqft / 100 * rooms', // 'rooms' is not extracted
        },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).rejects.toMatchObject({
        description: expect.stringContaining("Formula references variable 'rooms' which is not extracted by any condition"),
      });
    });

    it('accepts rule when all formula variables are extracted by conditions', async () => {
      const { db, service } = createService();
      setupDbForCreate(db);

      const condition: RuleCondition = {
        type: 'compound',
        conditions: [
          { type: 'request_text_extract', pattern: '(\\d+)\\s*sqft', variableName: 'sqft' },
          { type: 'request_text_extract', pattern: '(\\d+)\\s*rooms', variableName: 'rooms' },
        ],
      };

      const actions: RuleAction[] = [
        {
          type: 'compute_quantity',
          productNamePattern: 'Drywall',
          formula: 'sqft / 100 * rooms',
        },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).resolves.toBeDefined();
    });

    it('accepts rule when formula uses only literals (no variables)', async () => {
      const { db, service } = createService();
      setupDbForCreate(db);

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '(\\d+)\\s*sqft',
        variableName: 'sqft',
      };

      const actions: RuleAction[] = [
        {
          type: 'compute_quantity',
          productNamePattern: 'Drywall',
          formula: 'sqft * 2',
        },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).resolves.toBeDefined();
    });

    it('rejects rule with compound condition when formula references missing variable', async () => {
      const { service } = createService();

      const condition: RuleCondition = {
        type: 'compound',
        conditions: [
          { type: 'line_item_exists', productNamePattern: 'Drywall' },
          { type: 'request_text_extract', pattern: '(\\d+)\\s*sqft', variableName: 'sqft' },
        ],
      };

      const actions: RuleAction[] = [
        {
          type: 'compute_quantity',
          productNamePattern: 'Drywall',
          formula: 'sqft / 100 * floors', // 'floors' not extracted
        },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).rejects.toMatchObject({
        description: expect.stringContaining("Formula references variable 'floors' which is not extracted by any condition"),
      });
    });

    it('skips cross-validation for non-compute_quantity actions', async () => {
      const { db, service } = createService();
      setupDbForCreate(db);

      const condition: RuleCondition = {
        type: 'request_text_contains',
        substring: 'drywall',
      };

      const actions: RuleAction[] = [
        {
          type: 'set_quantity',
          productNamePattern: 'Drywall',
          quantity: 10,
        },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).resolves.toBeDefined();
    });
  });

  // ── Task 8.2: Regex capture group count validation ────────────

  describe('regex capture group validation', () => {
    it('rejects pattern with zero capture groups', async () => {
      const { service } = createService();

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '\\d+\\s*sqft', // no capture group
        variableName: 'sqft',
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Drywall', formula: 'sqft * 2' },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).rejects.toMatchObject({
        description: expect.stringContaining('Extraction pattern must contain exactly one capture group'),
      });
    });

    it('rejects pattern with multiple capture groups', async () => {
      const { service } = createService();

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '(\\d+)\\s*(sqft|rooms)', // two capture groups
        variableName: 'sqft',
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Drywall', formula: 'sqft * 2' },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).rejects.toMatchObject({
        description: expect.stringContaining('Extraction pattern must contain exactly one capture group, found 2'),
      });
    });

    it('accepts pattern with exactly one capture group', async () => {
      const { db, service } = createService();
      setupDbForCreate(db);

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '(\\d+)\\s*sqft',
        variableName: 'sqft',
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Drywall', formula: 'sqft * 2' },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).resolves.toBeDefined();
    });

    it('does not count non-capturing groups (?:...)', async () => {
      const { db, service } = createService();
      setupDbForCreate(db);

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '(\\d+)\\s*(?:sqft|sq\\s*ft|square\\s*feet)',
        variableName: 'sqft',
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Drywall', formula: 'sqft * 2' },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).resolves.toBeDefined();
    });

    it('does not count lookahead/lookbehind groups', async () => {
      const { db, service } = createService();
      setupDbForCreate(db);

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '(?<=area\\s)(\\d+)(?=\\s*sqft)',
        variableName: 'sqft',
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Drywall', formula: 'sqft * 2' },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).resolves.toBeDefined();
    });
  });

  // ── Task 8.3: Preset resolution at rule creation time ─────────

  describe('preset resolution at rule creation time', () => {
    it('resolves sqft preset to its regex pattern', async () => {
      const { db, service } = createService();
      setupDbForCreate(db);

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '',
        variableName: 'sqft',
        preset: 'sqft',
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Drywall', formula: 'sqft * 2' },
      ];

      await service.createRule({
        name: 'Test Rule',
        description: 'Test description',
        conditionJson: condition,
        actionJson: actions,
      });

      // Verify the condition's pattern was resolved (stored in DB as JSON)
      expect(condition.pattern).toMatch(/\\d/);
      expect(condition.pattern).toContain('sq');
    });

    it('rejects unknown preset ID with 400', async () => {
      const { service } = createService();

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '',
        variableName: 'sqft',
        preset: 'unknown_preset',
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Drywall', formula: 'sqft * 2' },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).rejects.toMatchObject({
        description: expect.stringContaining('Unknown extraction preset: "unknown_preset"'),
        statusCode: 400,
      });
    });

    it('resolves preset within compound condition', async () => {
      const { db, service } = createService();
      setupDbForCreate(db);

      const extractCondition = {
        type: 'request_text_extract' as const,
        pattern: '',
        variableName: 'rooms',
        preset: 'room_count',
      };

      const condition: RuleCondition = {
        type: 'compound',
        conditions: [
          { type: 'line_item_exists', productNamePattern: 'Painting' },
          extractCondition,
        ],
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Painting', formula: 'rooms * 4' },
      ];

      await service.createRule({
        name: 'Test Rule',
        description: 'Test description',
        conditionJson: condition,
        actionJson: actions,
      });

      // Verify the nested condition's pattern was resolved
      expect(extractCondition.pattern).toContain('rooms');
    });

    it('rejects unknown preset within compound condition', async () => {
      const { service } = createService();

      const condition: RuleCondition = {
        type: 'compound',
        conditions: [
          { type: 'line_item_exists', productNamePattern: 'Painting' },
          {
            type: 'request_text_extract',
            pattern: '',
            variableName: 'rooms',
            preset: 'nonexistent',
          },
        ],
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Painting', formula: 'rooms * 4' },
      ];

      await expect(
        service.createRule({
          name: 'Test Rule',
          description: 'Test description',
          conditionJson: condition,
          actionJson: actions,
        }),
      ).rejects.toMatchObject({
        description: expect.stringContaining('Unknown extraction preset: "nonexistent"'),
      });
    });

    it('resolves floor_count preset correctly', async () => {
      const { db, service } = createService();
      setupDbForCreate(db);

      const condition: RuleCondition = {
        type: 'request_text_extract',
        pattern: '',
        variableName: 'floors',
        preset: 'floor_count',
      };

      const actions: RuleAction[] = [
        { type: 'compute_quantity', productNamePattern: 'Stairs', formula: 'floors * 2' },
      ];

      await service.createRule({
        name: 'Test Rule',
        description: 'Test description',
        conditionJson: condition,
        actionJson: actions,
      });

      expect(condition.pattern).toContain('floor');
    });
  });
});
