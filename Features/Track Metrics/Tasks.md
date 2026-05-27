# Track Metrics: Request-to-Quote Deathclock -- Task Breakdown

**Status:** In Progress
**Owner:** Engineering Team
**Priority:** #1
**Total Tasks:** 28
**Estimated Timeline:** 7 days (4 phases)
**Progress Last Updated:** 2026-05-27

---

## Progress Summary

| Phase | Progress | Tasks |
|-------|----------|-------|
| 1: Backend Data Model + Core Logic | 13 / 13 (100%) | T1.1-T1.12 + QA-1.1 done |
| 2: Frontend Deathclock Badge | 1 / 8 (13%) | T2.1 done |
| 3: Detail View Enhancements | 0 / 4 (0%) | Not started |
| 4: Dashboard Analytics | 0 / 3 (0%) | Not started |

**Overall: 14 / 28 tasks complete (50%)**

### Activity Log
- **2026-05-26** — T1.1 completed (DB migration: fields added to Quote/Request)
- **2026-05-27** — T1.2 completed (QuoteSendEvent table + type)
- **2026-05-27** — T1.3 completed (deathclock indexes)
- **2026-05-27** — T1.4 completed (push endpoint modified with send tracking)
- **2026-05-27** — T1.5 completed (draft service sets first_draft_created_at)
- **2026-05-27** — T1.6 completed (computeDeathclock helper function)
- **2026-05-27** — T1.7 completed (queue query with age + sorting)
- **2026-05-27** — T1.8 completed (individual deathclock endpoint)
- **2026-05-27** — T1.9 completed (manual mark-sent endpoint)
- **2026-05-27** — T1.10 completed (dashboard deathclock-stats)
- **2026-05-27** — T1.11 completed (dashboard trends endpoint)
- **2026-05-27** — T1.12 completed (backfill migration + script for existing open requests)
- **2026-05-27** — QA-1.1 completed (Phase 1 integration tests — 30 tests, all passing)
- **2026-05-27** — T2.1 completed (DeathclockBadge React component)

---

## Phase 1: Backend Data Model + Core Logic (Day 1-2)

### T1.1 -- Database migration: add new fields to Quote/Request table
**Status:** ✅ Done
**Size:** M
**Dependencies:** None
**Description:** Create a migration that adds `quote_sent_at` (timestamp, nullable), `first_draft_created_at` (timestamp, nullable), `request_to_quote_seconds` (bigint, nullable), and `last_quote_sent_at` (timestamp, nullable) to the Quote or Request model as specified in the design doc Section 2.1.

### T1.2 -- Database migration: create QuoteSendEvent table
**Status:** ✅ Done
**Size:** M
**Dependencies:** T1.1
**Description:** Create the `QuoteSendEvent` audit log model with fields: `id`, `quote_id`, `request_id`, `sent_at`, `elapsed_seconds_from_request`, `send_type` (enum: first, resend). Add foreign key constraints.

### T1.3 -- Database migration: add required indexes
**Status:** ✅ Done
**Size:** S
**Dependencies:** T1.1
**Description:** Add indexes: `idx_quote_sent_at` (partial on NULL for active clocks), `idx_request_created_at`, and `idx_request_status_created` on `(status, request_created_at)` for efficient sort-by-age queries.

### T1.4 -- Update "send quote" action handler
**Status:** ✅ Done
**Size:** M
**Dependencies:** T1.1, T1.2
**Description:** Modify the `POST /api/quotes/send` endpoint to: set `quote_sent_at = NOW()`, compute and store `request_to_quote_seconds`, create a `QuoteSendEvent` record with `send_type = 'first'`. Ensure < 5ms added latency.

### T1.5 -- Update "create draft" action handler
**Status:** ✅ Done
**Size:** S
**Dependencies:** T1.1
**Description:** Modify `POST /api/quotes/draft` to set `first_draft_created_at = NOW()` if this is the first draft for the request. Compute `quote_creation_lag_seconds` as a supporting metric.

### T1.6 -- Build deathclock computation helper
**Status:** ✅ Done
**Size:** S
**Dependencies:** None
**Description:** Create a server-side helper function `computeDeathclock(requestCreatedAt, quoteSentAt)` that returns: `{ age_seconds, age_label, color, is_complete, frozen }`. Include: age cap at 90 days (returns "99+ days" + red), color thresholds (green < 24h, yellow < 48h, orange < 72h, red >= 72h), label formatting (Xh, X.Xd, Xd Xh, "99+ days").

### T1.7 -- Modify queue query to include age_seconds
**Status:** ✅ Done
**Size:** M
**Dependencies:** T1.6
**Description:** Modify the queue list endpoint (`GET /api/queue`) to accept `?include_deathclock=true` and `?sort_by=age_asc|age_desc`. Compute `age_seconds` via `EXTRACT(EPOCH FROM (NOW() - request_created_at))` in SQL. Embed the deathclock object in each item response. Ensure single-query, no N+1.

### T1.8 -- Build GET /api/requests/:id/deathclock endpoint
**Status:** ✅ Done
**Size:** S
**Dependencies:** T1.6
**Description:** New endpoint returning the live deathclock state for a single request. Response: `{ age_seconds, age_label, color, is_complete, frozen }`.

### T1.9 -- Build POST /api/requests/:id/mark-sent endpoint
**Status:** ✅ Done
**Size:** S
**Dependencies:** T1.1, T1.4
**Description:** New endpoint for manual/offline sends. Accepts optional timestamp (defaults to NOW()). Sets `quote_sent_at`, computes elapsed seconds, creates `QuoteSendEvent` with `send_type = 'first'`. Returns updated request.

### T1.10 -- Build GET /api/dashboard/deathclock-stats endpoint
**Status:** ✅ Done
**Size:** M
**Dependencies:** T1.6
**Description:** Aggregate endpoint returning bucket counts: `{ green: N, yellow: N, orange: N, red: N, total_active: N }`. Support 60s server-side caching (Redis or in-memory). Invalidate cache on any quote-send event.

### T1.11 -- Build GET /api/dashboard/trends endpoint
**Status:** ✅ Done
**Size:** M
**Dependencies:** T1.1, T1.2
**Description:** Compute and return rolling 7-day and 30-day average request-to-quote time. Include bucket_history for trend visualization. Cache with 5-minute TTL. Recalculate on demand or via hourly cron.

### T1.12 -- Run backfill migration for existing open requests
**Status:** ✅ Done
**Size:** M
**Dependencies:** T1.1
**Description:** One-time migration script that iterates all open requests: if `request_created_at` exists, use it (honest age); if no reliable timestamp, set `backfilled_at = NOW()` (age starts at 0); if quote sent but no `quote_sent_at`, set `metric_status = 'no_data'`. Add `backfilled_at` field if needed.

### QA-1.1 -- Phase 1 integration tests
**Status:** ✅ Done
**Size:** M
**Dependencies:** T1.1 through T1.12
**Description:** Write integration tests covering: quote send sets timestamps correctly, draft creation sets first_draft_created_at, deathclock computation covers all thresholds, sort-by-age returns correct ordering, mark-sent endpoint works with and without custom timestamp, backfill does not break existing data, QuoteSendEvent records are created on send.

---

## Phase 2: Frontend Deathclock Badge (Day 3-4)

### T2.1 -- Build DeathclockBadge React component
**Status:** ✅ Done
**Size:** M
**Dependencies:** None (frontend, can parallel with Phase 1)
**Description:** Create reusable `DeathclockBadge` component. Props: `ageSeconds`, `color`, `isComplete`, `frozen`. Renders: time label (via getDeathclockLabel) and a small colored dot icon with aria-label. Color logic mirrors server-side helper. Frozen mode: static display, no animation.

### T2.2 --
**Status:** ⬜ Waiting Add deathclock badge to request queue card
**Size:** S
**Dependencies:** T2.1, T1.7
**Description:** Render the `DeathclockBadge` in the top-right corner of each request card in the queue. Add a left-side color strip on the card border matching the deathclock color. Wire up to the deathclock data from the queue API response.

### T2.3 --
**Status:** ⬜ Waiting Implement sort-by-age toggle on queue
**Size:** S
**Dependencies:** T1.7, T2.2
**Description:** Add a sort toggle to the queue view with options: "Oldest First" (default for deathclock view), "Newest First", plus existing sort options. Implement via URL query param `?sort=age_asc` or `?sort=age_desc`.

### T2.4 --
**Status:** ⬜ Waiting Implement 60s polling with local tick interpolation
**Size:** M
**Dependencies:** T2.2
**Description:** Poll the queue endpoint every 60 seconds when the queue page is visible. Use `setInterval` with visibility detection (pause when tab hidden). Between polls, increment a local counter so the badge label ticks forward live. On page focus, trigger an immediate fresh poll. Disable cache via `Cache-Control: no-cache`.

### T2.5 --
**Status:** ⬜ Waiting Add pulsing animation for yellow/orange/red thresholds
**Size:** S
**Dependencies:** T2.1
**Description:** Add a gentle CSS border/glow pulse animation that activates at yellow, orange, and red thresholds. No animation when `isComplete` or `frozen` is true. Ensure animation is subtle and does not degrade performance or accessibility.

### QA-2.1 --
**Status:** ⬜ Waiting Phase 2 frontend tests
**Size:** M
**Dependencies:** T2.1 through T2.5
**Description:** Test: DeathclockBadge renders all threshold colors correctly, label formatting matches spec (Xh, X.Xd, Xd Xh, "99+ days"), sort-by-age reorders cards, polling triggers every 60s and updates display, local tick increments smoothly between polls, pulsing animation activates at correct thresholds, frozen mode disables animation, tab visibility pausing works, aria-labels are present.

---

## Phase 3: Detail View + Dashboard (Day 5-6)

### T3.1 --
**Status:** ⬜ Waiting Add deathclock badge to request detail header
**Size:** S
**Dependencies:** T2.1, T1.8
**Description:** Render a larger `DeathclockBadge` in the request detail view header. Pull live data from `GET /api/requests/:id/deathclock`. Show the badge prominently with the color strip on the left.

### T3.2 --
**Status:** ⬜ Waiting Add creation lag and send lag breakdown in detail view
**Size:** S
**Dependencies:** T3.1
**Description:** Below the main deathclock badge in the detail view, add a breakdown section showing: "Request age", "Quote creation lag", and "Send lag" with their respective time labels. For completed quotes, also show "Original time" and "Last sent" for re-sends.

### T3.3 --
**Status:** ⬜ Waiting Build team dashboard aggregate view (bucket counts)
**Size:** M
**Dependencies:** T1.10, T2.1
**Description:** Build the aggregate dashboard panel showing a bar or donut chart of bucket counts (green/yellow/orange/red). Each bucket is clickable to drill into the list of requests in that bucket. Pull data from `GET /api/dashboard/deathclock-stats`. Auto-refresh every 60s.

### T3.4 --
**Status:** ⬜ Waiting Add 7d/30d trend chart to dashboard
**Size:** M
**Dependencies:** T1.11, T3.3
**Description:** Add a trend line chart below the bucket breakdown showing rolling 7-day and 30-day average request-to-quote time. Pull data from `GET /api/dashboard/trends`. Cache with 5-minute refresh. Show a baseline marker for SLA target (24h).

### T3.5 -- Add per-request historical time-to-send in completed quote detail
**Size:** S
**Dependencies:** T1.4, T3.1
**Description:** In the completed quote detail view, display the stored `request_to_quote_seconds` as a human-readable time label. Show the frozen color badge. For re-sends, list all `QuoteSendEvent` records with timestamps and types.

### QA-3.1 -- Phase 3 integration and UI tests
**Size:** M
**Dependencies:** T3.1 through T3.5
**Description:** Test: detail view badge matches queue badge for same request, breakdown labels are correct, dashboard bucket counts match live queue data, trend chart renders historical data correctly, completed quote detail shows frozen badge with final time, re-send events are listed, dashboard auto-refresh works.

---

## Phase 4: Polish + Edge Cases (Day 7)

### T4.1 --
**Status:** ⬜ Waiting Handle 99+ day cap and stale request display
**Size:** S
**Dependencies:** T2.1, T1.6
**Description:** Ensure any request older than 90 days displays "99+ days" (not absurd values like "8,760h") and shows the darkest red tint. Server-side clamp: `LEAST(age_seconds, 90 * 86400)`. Frontend: if age_seconds >= 90*86400, show "99+ days" directly.

### T4.2 --
**Status:** ⬜ Waiting Frozen badge for completed requests
**Size:** S
**Dependencies:** T2.1
**Description:** When `isComplete` or `frozen` is true: deathclock badge is static, no pulsing animation, no color transitions. Color is frozen at the threshold reached at time of send. The badge shows the final elapsed time.

### T4.3 --
**Status:** ⬜ Waiting Accessibility pass
**Size:** S
**Dependencies:** T2.1, T2.2, T3.1, T3.3
**Description:** Add `aria-label` attributes on all deathclock badges (e.g., "Age: 8 hours - within SLA"). Ensure color is never the only indicator -- badge text always shows numeric time. Yellow/orange/red cards get a `title` attribute with urgency text. Run an automated accessibility check.

### T4.4 -- "Mark as sent" UI in request detail view
**Size:** M
**Dependencies:** T1.9, T3.1
**Description:** Add a "Mark as sent" button/action in the request detail view for requests where the quote was sent outside the system. Button opens a confirmation dialog accepting an optional timestamp (defaults to now). Calls `POST /api/requests/:id/mark-sent`. On success, refreshes the request detail.

### T4.5 -- Multiple quotes per request display
**Size:** S
**Dependencies:** T3.1, T3.5
**Description:** In the detail view, if a request has multiple child quotes: primary metric shows time to first quote send. List all child quotes with their individual send times. Show "N quotes" count in the badge area. Ensure the deathclock for the request stops at first send.

### T4.6 -- Reopened/re-sent quote display
**Size:** S
**Dependencies:** T1.2, T3.5
**Description:** For quotes that were sent, reopened, and re-sent: `quote_sent_at` stays as the first send. `last_quote_sent_at` tracks the most recent send. Detail view shows: "Original time: Xh" and "Last sent: Yh ago". All events are listed in the QuoteSendEvent audit log.

### QA-4.1 -- End-to-end acceptance tests
**Size:** L
**Dependencies:** All tasks
**Description:** Full E2E tests covering all acceptance criteria from the requirements doc:
- AC-01: Request-to-quote time computed and stored
- AC-02: Live deathclock badge on all active requests
- AC-03: Color coding matches thresholds
- AC-04: Sort-by-age works (ascending and descending)
- AC-05: Deathclock updates without full page refresh (polling < 60s)
- AC-06: Dashboard shows aggregate bucket counts
- AC-07: Completed quotes show time-to-send in detail view
- AC-08: Edge cases handled (99+ day cap, backfill, offline sends, multiple quotes, re-sends, timezone)
- AC-09: Accessibility: color not the only indicator
- AC-10: < 200ms added latency to existing actions
- Run on staging environment with realistic data volume.

### QA-4.2 -- Performance benchmark tests
**Size:** M
**Dependencies:** All tasks
**Description:** Measure: queue page load time with 50+ active requests, deathclock computation latency (< 5ms per request), quote-send write-path latency (< 5ms added), dashboard aggregate query under load (cache hit/miss), polling overhead with concurrent users. Validate AC-10 (< 200ms added latency to any existing action).

---

## Task Summary

| Phase | Tasks | Estimated Days | Key Deliverables |
|-------|-------|---------------|------------------|
| Phase 1: Backend Data Model + Core Logic | 12 tasks (T1.1-T1.12 + QA-1.1) | 2 | Migrations, API endpoints, deathclock helper, backfill |
| Phase 2: Frontend Deathclock Badge | 5 tasks (T2.1-T2.5 + QA-2.1) | 2 | DeathclockBadge component, polling, sort, animations |
| Phase 3: Detail View + Dashboard | 5 tasks (T3.1-T3.5 + QA-3.1) | 2 | Detail view badge, lag breakdown, dashboard, trends |
| Phase 4: Polish + Edge Cases | 6 tasks (T4.1-T4.6 + QA-4.1, QA-4.2) | 1 | Edge cases, accessibility, mark-as-sent UI, E2E tests |
| **Total** | **28 tasks** | **7 days** | |

## Dependency Graph (Top-Level)

```
T1.1 ─┬─> T1.3 ──> T1.4 ──> T1.9
      ├─> T1.2 ──> T1.4
      └─> T1.12

T1.6 ──> T1.7 ──> T2.2 ──> T2.4
      ├─> T1.8 ──> T3.1
      └─> T1.10 ──> T3.3
           T1.11 ──> T3.4

T2.1 ──> T2.2, T2.5, T3.1, T3.3, T4.1, T4.2, T4.3
T3.1 ──> T3.2, T4.4, T4.5
```

## Acceptance Criteria Mapping

| AC ID | Covers | Verified By |
|-------|--------|-------------|
| AC-01 | T1.4 | QA-1.1, QA-4.1 |
| AC-02 | T2.1, T2.2, T2.4 | QA-2.1, QA-4.1 |
| AC-03 | T1.6, T2.1, T2.2 | QA-2.1, QA-4.1 |
| AC-04 | T1.7, T2.3 | QA-2.1, QA-4.1 |
| AC-05 | T2.4 | QA-2.1, QA-4.1 |
| AC-06 | T1.10, T3.3 | QA-3.1, QA-4.1 |
| AC-07 | T1.4, T3.5 | QA-3.1, QA-4.1 |
| AC-08 | T1.12, T4.1, T4.5, T4.6, T4.4 | QA-4.1 |
| AC-09 | T4.3 | QA-4.1 |
| AC-10 | T1.4, T1.7, T2.4 | QA-4.2 |