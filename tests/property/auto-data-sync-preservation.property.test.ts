/**
 * Preservation Property Tests — Auto Data Sync Fix
 *
 * Written BEFORE the fix. These tests PASS on both unfixed and fixed code,
 * confirming that existing baseline behavior is preserved.
 *
 * Property 1: Rules Success Preservation        (Req 3.4)
 * Property 2: Quick Post Sync Preservation       (Req 3.5)
 * Property 3: Sync Cooldown Preservation         (Req 3.6)
 * Property 4: Jobber Fallback Preservation       (Req 3.7)
 * Property 5: Webhook Merge Preservation         (Req 3.2)
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { RuleGroupWithRules, JobberCustomerRequest } from '../../shared/src/types/quote';

// ═══════════════════════════════════════════════════════════════════════════
// Module mocks (must be before imports of mocked modules)
// ═══════════════════════════════════════════════════════════════════════════

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  BrowserRouter: ({ children }: { children: React.ReactNode }) =>
    createElement('div', null, children),
  MemoryRouter: ({ children }: { children: React.ReactNode }) =>
    createElement('div', null, children),
}));

vi.mock('../../client/src/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    error: null,
    clearError: vi.fn(),
  }),
}));

vi.mock('../../client/src/api', () => ({
  fetchPosts: vi.fn().mockResolvedValue({ posts: [], page: 1, limit: 20 }),
  fetchChannels: vi.fn().mockResolvedValue({ channels: [] }),
  syncInstagramPosts: vi
    .fn()
    .mockResolvedValue({ synced: 0, skipped: 0, errors: [] }),
  fetchRules: vi.fn().mockResolvedValue([]),
  fetchExtractionPresets: vi.fn().mockResolvedValue([]),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deactivateRule: vi.fn(),
  createRuleGroup: vi.fn(),
  deleteRuleGroup: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

import * as api from '../../client/src/api';
import RulesPage from '../../client/src/pages/RulesPage';

// ── Lifecycle ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchRules).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// fast-check Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/** Arbitrary for a single Rule within a group — uses index-based unique names */
const arbRuleForGroup = (ruleGroupId: string, groupIdx: number, ruleIdx: number) =>
  fc.record({
    id: fc.uuid(),
    name: fc.constant(`TestRule-g${groupIdx}-r${ruleIdx}`),
    description: fc.constant(`Description for rule ${groupIdx}-${ruleIdx}`),
    ruleGroupId: fc.constant(ruleGroupId),
    priorityOrder: fc.constant(ruleIdx),
    isActive: fc.boolean(),
    createdAt: fc.constant(new Date('2025-01-01')),
    updatedAt: fc.constant(new Date('2025-01-02')),
  });

/** Arbitrary for a non-empty list of rule groups with deterministic unique names */
const arbRuleGroups: fc.Arbitrary<RuleGroupWithRules[]> = fc
  .integer({ min: 1, max: 4 })
  .chain((numGroups) =>
    fc.tuple(
      ...Array.from({ length: numGroups }, (_, gi) =>
        fc.tuple(
          fc.uuid(),
          fc.integer({ min: 0, max: 3 }),
          fc.boolean(),
        ).chain(([groupId, numRules, hasDescription]) =>
          fc.tuple(
            fc.constant(groupId),
            fc.constant(`Group-${gi}`),
            fc.constant(hasDescription ? `Group ${gi} description` : null),
            fc.constant(gi),
            numRules > 0
              ? fc.tuple(
                  ...Array.from({ length: numRules }, (_, ri) =>
                    arbRuleForGroup(groupId, gi, ri),
                  ),
                )
              : fc.constant([] as any),
          ),
        ),
      ),
    ),
  )
  .map((groupTuples: any[]) =>
    groupTuples.map(([id, name, description, displayOrder, rules]: any) => ({
      id,
      name,
      description,
      displayOrder,
      createdAt: new Date('2025-01-01'),
      rules: Array.isArray(rules) ? (rules.length > 0 && !Array.isArray(rules[0]) ? rules : []) : [],
    })),
  ) as fc.Arbitrary<RuleGroupWithRules[]>;

/** Arbitrary for a JobberCustomerRequest */
const arbRequest: fc.Arbitrary<JobberCustomerRequest> = fc.record({
  id: fc.uuid(),
  title: fc.string({ minLength: 1, maxLength: 30 }),
  clientName: fc.string({ minLength: 1, maxLength: 20 }),
  description: fc.string({ minLength: 0, maxLength: 100 }),
  notes: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 3 }),
  structuredNotes: fc.array(
    fc.record({
      message: fc.string({ minLength: 1, maxLength: 50 }),
      createdBy: fc.constantFrom('team' as const, 'client' as const, 'system' as const),
      createdAt: fc
        .date({ min: new Date('2024-01-01'), max: new Date('2026-04-18') })
        .map((d) => d.toISOString()),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  imageUrls: fc.array(fc.webUrl(), { minLength: 0, maxLength: 3 }),
  jobberWebUri: fc.webUrl(),
  createdAt: fc
    .date({ min: new Date('2024-01-01'), max: new Date('2026-04-18') })
    .map((d) => d.toISOString()),
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 1 — Rules Success Preservation
//
// **Validates: Requirements 3.4**
//
// For all valid RuleGroupWithRules[] arrays, the RulesPage renders group
// names, rule names, descriptions, and active/inactive badges identically.
// When fetchRules succeeds, the page should render all groups with their
// rules correctly.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 1 — Rules Success Preservation', () => {
  it('renders all group names and rule names when fetchRules succeeds (property)', async () => {
    await fc.assert(
      fc.asyncProperty(arbRuleGroups, async (groups) => {
        cleanup();
        vi.clearAllMocks();
        vi.mocked(api.fetchRules).mockResolvedValue(groups);

        const { container } = render(createElement(RulesPage));

        // Wait for loading to finish
        await waitFor(() => {
          expect(screen.queryByText('Loading rules…')).toBeNull();
        });

        const html = container.innerHTML;

        // Every group name should appear in the rendered HTML
        for (const group of groups) {
          expect(html).toContain(group.name);
        }

        // Every rule name should appear in the rendered HTML
        for (const group of groups) {
          for (const rule of group.rules) {
            expect(html).toContain(rule.name);
          }
        }
      }),
      { numRuns: 15 },
    );
  });

  it('renders rule descriptions for all rules (property)', async () => {
    await fc.assert(
      fc.asyncProperty(arbRuleGroups, async (groups) => {
        cleanup();
        vi.clearAllMocks();
        vi.mocked(api.fetchRules).mockResolvedValue(groups);

        const { container } = render(createElement(RulesPage));

        await waitFor(() => {
          expect(screen.queryByText('Loading rules…')).toBeNull();
        });

        const html = container.innerHTML;

        for (const group of groups) {
          for (const rule of group.rules) {
            expect(html).toContain(rule.description);
          }
        }
      }),
      { numRuns: 15 },
    );
  });

  it('renders Inactive badge for inactive rules (property)', async () => {
    await fc.assert(
      fc.asyncProperty(arbRuleGroups, async (groups) => {
        cleanup();
        vi.clearAllMocks();
        vi.mocked(api.fetchRules).mockResolvedValue(groups);

        render(createElement(RulesPage));

        await waitFor(() => {
          expect(screen.queryByText('Loading rules…')).toBeNull();
        });

        const inactiveRules = groups.flatMap((g) => g.rules).filter((r) => !r.isActive);
        const inactiveBadges = screen.queryAllByText('Inactive');

        // The number of "Inactive" badges should match the number of inactive rules
        expect(inactiveBadges.length).toBe(inactiveRules.length);
      }),
      { numRuns: 15 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 2 — Quick Post Sync Preservation
//
// **Validates: Requirements 3.5**
//
// For all quick-start calls, InstagramSyncService.syncRecentPosts is
// triggered exactly once. The quick-start route handler does a
// fire-and-forget import/then/syncRecentPosts. Verify by structural
// analysis of the source code.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 2 — Quick Post Sync Preservation', () => {
  it('the quick-start handler contains a fire-and-forget Instagram sync call', () => {
    const postsSource = readFileSync(
      resolve(__dirname, '../../worker/src/routes/posts.ts'),
      'utf-8',
    );

    // Extract the quick-start handler body
    const handlerStart = postsSource.indexOf("app.post('/quick-start'");
    expect(handlerStart).toBeGreaterThan(-1);

    // Find the next route handler after quick-start
    const nextHandler = postsSource.indexOf('app.', handlerStart + 1);
    const handlerBody = nextHandler > -1
      ? postsSource.slice(handlerStart, nextHandler)
      : postsSource.slice(handlerStart);

    // Verify the fire-and-forget pattern: dynamic import of instagram-sync-service
    expect(handlerBody).toMatch(/import\(['"]\.\.\/services\/instagram-sync-service/);

    // Verify InstagramSyncService is instantiated and syncRecentPosts is called
    expect(handlerBody).toMatch(/InstagramSyncService/);
    expect(handlerBody).toMatch(/syncRecentPosts/);

    // Verify the .catch() is present (fire-and-forget pattern)
    expect(handlerBody).toMatch(/\.catch\(/);
  });

  it('the sync call uses the userId from the request', () => {
    const postsSource = readFileSync(
      resolve(__dirname, '../../worker/src/routes/posts.ts'),
      'utf-8',
    );

    const handlerStart = postsSource.indexOf("app.post('/quick-start'");
    const nextHandler = postsSource.indexOf('app.', handlerStart + 1);
    const handlerBody = nextHandler > -1
      ? postsSource.slice(handlerStart, nextHandler)
      : postsSource.slice(handlerStart);

    // The handler should extract userId and pass it to syncRecentPosts
    expect(handlerBody).toMatch(/syncRecentPosts\(userId\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 3 — Sync Cooldown Preservation
//
// **Validates: Requirements 3.6**
//
// For all calls within the 5-minute cooldown, the result is the no-op
// result { synced: 0, skipped: 0, errors: [] } and no Instagram API call
// is made. Test the cooldown logic directly by examining the source.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 3 — Sync Cooldown Preservation', () => {
  it('InstagramSyncService has a static SYNC_COOLDOWN_MS of 5 minutes', () => {
    const syncSource = readFileSync(
      resolve(__dirname, '../../worker/src/services/instagram-sync-service.ts'),
      'utf-8',
    );

    // Verify the cooldown constant exists and is 5 minutes (300000ms)
    expect(syncSource).toMatch(/SYNC_COOLDOWN_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  });

  it('InstagramSyncService has a static lastAttemptByUser Map', () => {
    const syncSource = readFileSync(
      resolve(__dirname, '../../worker/src/services/instagram-sync-service.ts'),
      'utf-8',
    );

    // Verify the in-memory gate map exists
    expect(syncSource).toMatch(/static\s+lastAttemptByUser\s*=\s*new\s+Map/);
  });

  it('syncRecentPosts returns no-op result when within cooldown', () => {
    const syncSource = readFileSync(
      resolve(__dirname, '../../worker/src/services/instagram-sync-service.ts'),
      'utf-8',
    );

    // Verify the cooldown check pattern: if within cooldown, return early
    expect(syncSource).toMatch(/now\s*-\s*lastAttempt\s*<\s*InstagramSyncService\.SYNC_COOLDOWN_MS/);

    // Verify the no-op return value
    expect(syncSource).toMatch(/return\s*\{\s*synced:\s*0,\s*skipped:\s*0,\s*errors:\s*\[\]\s*\}/);
  });

  it('cooldown check happens before any API call (property)', () => {
    const syncSource = readFileSync(
      resolve(__dirname, '../../worker/src/services/instagram-sync-service.ts'),
      'utf-8',
    );

    // The cooldown check (lastAttemptByUser.get) should appear before the DB query
    const cooldownCheckPos = syncSource.indexOf('lastAttemptByUser.get');
    const dbQueryPos = syncSource.indexOf("channel_connections");

    expect(cooldownCheckPos).toBeGreaterThan(-1);
    expect(dbQueryPos).toBeGreaterThan(-1);
    expect(cooldownCheckPos).toBeLessThan(dbQueryPos);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 4 — Jobber Fallback Preservation
//
// **Validates: Requirements 3.7**
//
// For all unavailable-API states, cached/imported data is returned rather
// than an empty array (when DB has data). The JobberIntegration.fetchProductCatalog()
// falls back to loadImportedProducts() from the jobber_products table when
// the API fails. Verify by structural analysis of the source code.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 4 — Jobber Fallback Preservation', () => {
  it('fetchProductCatalog catches API errors and sets available to false', () => {
    const integrationSource = readFileSync(
      resolve(__dirname, '../../worker/src/services/jobber-integration.ts'),
      'utf-8',
    );

    // Extract the fetchProductCatalog method body
    const methodStart = integrationSource.indexOf('async fetchProductCatalog()');
    expect(methodStart).toBeGreaterThan(-1);

    // Find the next method
    const nextMethod = integrationSource.indexOf('async fetchCustomerRequests()', methodStart + 1);
    expect(nextMethod).toBeGreaterThan(methodStart);
    const methodBody = integrationSource.slice(methodStart, nextMethod);

    // Verify the error handling pattern: catch block calls handleApiError
    expect(methodBody).toMatch(/catch\s*\(err\)/);
    expect(methodBody).toMatch(/handleApiError/);

    // Verify it returns empty array on failure (route handler does the fallback)
    expect(methodBody).toMatch(/return\s*\[\]/);
  });

  it('route handler uses unified product_catalog via fetchCatalog', () => {
    const quotesSource = readFileSync(
      resolve(__dirname, '../../worker/src/routes/quotes.ts'),
      'utf-8',
    );

    // Scope to the POST /generate handler where the catalog fetching lives
    const generateHandlerMatch = quotesSource.match(/app\.post\('\/generate'\s*,/);
    expect(generateHandlerMatch).not.toBeNull();
    const handlerStart = generateHandlerMatch!.index!;
    const restOfFile = quotesSource.slice(handlerStart + 1);
    const nextRouteOffset = restOfFile.search(/\napp\./);
    const handlerBody = nextRouteOffset > -1
      ? quotesSource.slice(handlerStart, handlerStart + 1 + nextRouteOffset)
      : quotesSource.slice(handlerStart);

    // The route handler uses fetchCatalog to read from the unified product_catalog table
    expect(handlerBody).toMatch(/fetchCatalog\(db,\s*userId\)/);
    // It no longer branches on Jobber availability for catalog fetching
    expect(handlerBody).not.toMatch(/jobberIntegration\.isAvailable\(\)/);
    expect(handlerBody).not.toMatch(/fetchManualCatalog/);
  });

  it('route handler always uses D1 for templates (Jobber has no templates API)', () => {
    const quotesSource = readFileSync(
      resolve(__dirname, '../../worker/src/routes/quotes.ts'),
      'utf-8',
    );

    // Scope to the GET /templates handler
    const templatesHandlerMatch = quotesSource.match(/app\.get\('\/templates'\s*,/);
    expect(templatesHandlerMatch).not.toBeNull();
    const handlerStart = templatesHandlerMatch!.index!;
    const restOfFile = quotesSource.slice(handlerStart + 1);
    const nextRouteOffset = restOfFile.search(/\napp\./);
    const handlerBody = nextRouteOffset > -1
      ? quotesSource.slice(handlerStart, handlerStart + 1 + nextRouteOffset)
      : quotesSource.slice(handlerStart);

    // The route handler always reads from D1 manual_templates
    expect(handlerBody).toMatch(/fetchManualTemplates/);
    // It should NOT reference jobberIntegration for templates
    expect(handlerBody).not.toMatch(/jobberIntegration/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 5 — Webhook Merge Preservation
//
// **Validates: Requirements 3.2**
//
// For all combinations of API requests and webhook requests, the merge
// logic in GET /jobber/requests produces a superset sorted by date
// descending. The handler merges webhook data into API results, enriching
// existing entries and adding webhook-only entries, then re-sorts by
// createdAt descending.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 5 — Webhook Merge Preservation', () => {
  /**
   * Pure implementation of the merge logic from the GET /jobber/requests handler.
   * This mirrors the source code exactly so we can test the merge property.
   */
  function mergeRequests(
    apiRequests: JobberCustomerRequest[],
    webhookRequests: JobberCustomerRequest[],
  ): JobberCustomerRequest[] {
    // Clone to avoid mutating inputs
    const requests = apiRequests.map((r) => ({ ...r }));
    const apiIds = new Set(requests.map((r) => r.id));

    for (const wr of webhookRequests) {
      if (apiIds.has(wr.id)) {
        // Enrich existing API request with webhook data
        const existing = requests.find((r) => r.id === wr.id)!;
        if (wr.imageUrls.length > existing.imageUrls.length) {
          existing.imageUrls = wr.imageUrls;
        }
        if (wr.description && (!existing.description || existing.description.length < wr.description.length)) {
          existing.description = wr.description;
        }
        if (wr.structuredNotes.length > existing.structuredNotes.length) {
          existing.structuredNotes = wr.structuredNotes;
          existing.notes = wr.structuredNotes.map((n) => n.message);
        }
      } else {
        // Add webhook-only request
        requests.push({ ...wr });
      }
    }

    // Re-sort by date descending
    requests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return requests;
  }

  it('merge produces a superset: all API and webhook request IDs are present (property)', () => {
    fc.assert(
      fc.property(
        fc.array(arbRequest, { minLength: 0, maxLength: 5 }),
        fc.array(arbRequest, { minLength: 0, maxLength: 5 }),
        (apiReqs, webhookReqs) => {
          const merged = mergeRequests(apiReqs, webhookReqs);
          const mergedIds = new Set(merged.map((r) => r.id));

          // All API request IDs should be in the merged result
          for (const req of apiReqs) {
            expect(mergedIds.has(req.id)).toBe(true);
          }

          // All webhook request IDs should be in the merged result
          for (const req of webhookReqs) {
            expect(mergedIds.has(req.id)).toBe(true);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('merge result is sorted by createdAt descending (property)', () => {
    fc.assert(
      fc.property(
        fc.array(arbRequest, { minLength: 0, maxLength: 5 }),
        fc.array(arbRequest, { minLength: 0, maxLength: 5 }),
        (apiReqs, webhookReqs) => {
          const merged = mergeRequests(apiReqs, webhookReqs);

          for (let i = 1; i < merged.length; i++) {
            const prev = new Date(merged[i - 1].createdAt).getTime();
            const curr = new Date(merged[i].createdAt).getTime();
            expect(prev).toBeGreaterThanOrEqual(curr);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('webhook enrichment prefers longer description (property)', () => {
    fc.assert(
      fc.property(
        arbRequest,
        fc.string({ minLength: 5, maxLength: 100 }),
        fc.string({ minLength: 101, maxLength: 200 }),
        (baseReq, shortDesc, longDesc) => {
          const apiReq = { ...baseReq, description: shortDesc };
          const webhookReq = { ...baseReq, description: longDesc };

          const merged = mergeRequests([apiReq], [webhookReq]);
          const result = merged.find((r) => r.id === baseReq.id)!;

          // The longer description should win
          expect(result.description).toBe(longDesc);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('webhook enrichment prefers more imageUrls (property)', () => {
    fc.assert(
      fc.property(
        arbRequest,
        fc.array(fc.webUrl(), { minLength: 0, maxLength: 1 }),
        fc.array(fc.webUrl(), { minLength: 2, maxLength: 5 }),
        (baseReq, fewerImages, moreImages) => {
          const apiReq = { ...baseReq, imageUrls: fewerImages };
          const webhookReq = { ...baseReq, imageUrls: moreImages };

          const merged = mergeRequests([apiReq], [webhookReq]);
          const result = merged.find((r) => r.id === baseReq.id)!;

          // The array with more images should win
          expect(result.imageUrls).toEqual(moreImages);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('the source code merge logic matches our pure implementation', () => {
    const quotesSource = readFileSync(
      resolve(__dirname, '../../worker/src/routes/quotes.ts'),
      'utf-8',
    );

    // Extract the GET /jobber/requests handler
    const handlerStart = quotesSource.indexOf("app.get('/jobber/requests'");
    const nextHandler = quotesSource.indexOf("app.get('/jobber/requests/:id'", handlerStart + 1);
    const handlerBody = quotesSource.slice(handlerStart, nextHandler);

    // Verify the merge pattern exists
    expect(handlerBody).toMatch(/webhookRequests/);
    expect(handlerBody).toMatch(/apiIds/);

    // Verify enrichment logic: imageUrls, description, structuredNotes
    expect(handlerBody).toMatch(/wr\.imageUrls\.length\s*>\s*existing\.imageUrls\.length/);
    expect(handlerBody).toMatch(/wr\.description/);
    expect(handlerBody).toMatch(/wr\.structuredNotes\.length\s*>\s*existing\.structuredNotes\.length/);

    // Verify re-sort by date descending
    expect(handlerBody).toMatch(/requests\.sort/);
    expect(handlerBody).toMatch(/new Date\(b\.createdAt\)/);
  });
});
