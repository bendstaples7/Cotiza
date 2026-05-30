# Track Metrics: Request-to-Quote Deathclock -- Technical Design

**Status:** Draft  
**Design Owner:** Architect  
**Feature Priority:** #1  
**Dependencies:** None  

---

## 1. Overview

Add a live, color-coded "deathclock" to every request card in the Cotiza queue that shows how long a request has been waiting for a quote. The clock ticks in real time, changes color as thresholds are crossed, and enables sort-by-age for triage. Also record completions so the team can track SLA performance over time.

---

## 2. Data Model Changes

### 2.1 New Fields on the `Quote` Table/Model

Assuming the existing `Quote` or `Request` model has `created_at` (when the request came in). Add:

| Field | Type | Nullable | Default | Purpose |
|---|---|---|---|---|
| `quote_sent_at` | timestamp (UTC) | Yes | `NULL` | Time the quote was first sent to the customer |
| `first_draft_created_at` | timestamp (UTC) | Yes | `NULL` | Time the first draft quote was created |
| `request_to_quote_seconds` | bigint | Yes | `NULL` | Pre-computed elapsed seconds (request_created_at to quote_sent_at). Set on send. |
| `last_quote_sent_at` | timestamp (UTC) | Yes | `NULL` | For re-sends: tracks most recent send (distinct from first send) |

If the model is `Request` (one request may have multiple quotes), add these fields to the `Request` model instead, plus a foreign key `first_quote_id` and `sent_quote_count`.

### 2.2 New Model: `QuoteSendEvent` (Optional but Recommended)

For audit logging of re-sends and for trend analytics:

| Field | Type | Notes |
|---|---|---|
| `id` | auto-increment PK | |
| `quote_id` | FK -> Quote | |
| `request_id` | FK -> Request | Denormalized for faster queries |
| `sent_at` | timestamp (UTC) | |
| `elapsed_seconds_from_request` | bigint | Pre-computed |
| `send_type` | enum | `first`, `resend` |

### 2.3 New Indexes

- `idx_quote_sent_at` on `quote_sent_at` (nullable, partial index: `WHERE quote_sent_at IS NULL` for active clocks)
- `idx_request_created_at` on `request_created_at` (for sort-by-age queries)
- `idx_request_status_created` on `(status, request_created_at)` for fetching active requests sorted by age

---

## 3. Backend Logic

### 3.1 Timer Start

The deathclock **starts** when a request is created:
- `request_created_at` = current UTC timestamp on request creation
- No special timer infrastructure needed -- age is computed live as `NOW() - request_created_at`

### 3.2 Timer Stop

The deathclock **stops** when `quote_sent_at` is set:
- On the "send quote" action, record `quote_sent_at = NOW()`
- Compute `request_to_quote_seconds = quote_sent_at - request_created_at`
- Store the final elapsed time
- The deathclock badge becomes static / frozen

### 3.3 Quote Creation Lag

When the first quote draft is created, set `first_draft_created_at`:
- `quote_creation_lag_seconds = first_draft_created_at - request_created_at`
- Displayed as a supporting metric in the detail view

### 3.4 Backfill Strategy (Existing Open Requests)

For any request that already exists with no quote sent:
- **If `request_created_at` exists and is a real timestamp**: start deathclock from `request_created_at`. Show the true age. This handles open requests that were created before the feature shipped.
- **If no reliable timestamp exists** (imported data, no `request_created_at`): set `backfilled_at = NOW()` and treat current age as 0h. The clock starts fresh.
- **If a quote was already sent but no `quote_sent_at`**: set `metric_status = 'no_data'`. Display "No data" rather than a misleading age.
- Run a one-time migration script that iterates all open requests and stamps them appropriately.

### 3.5 Edge Cases Handled Server-Side

- **Age > 90 days**: Cap badge display at "99+ days" and show darkest red. The query clamps: `LEAST(age_in_seconds, 90 * 86400)`.
- **Multiple quotes per request**: Primary metric = time to first send. Subsequent sends recorded in `QuoteSendEvent`.
- **Quote sent, reopened, re-sent**: `quote_sent_at` stays as first send. `last_quote_sent_at` tracks latest. Detail view shows both.
- **Manual/offline sends**: Add a "Mark as sent" API action that accepts a timestamp (defaults to now) and records `quote_sent_at`.
- **Timezone**: All timestamps in UTC. Age computed from UTC `NOW()`. Display converted to viewer's local time on frontend.

---

## 4. API Endpoints

### 4.1 Existing Endpoints Modified

| Endpoint | Change |
|---|---|
| `POST /api/requests` | Auto-set `request_created_at = NOW()` if not provided |
| `POST /api/quotes/send` | Set `quote_sent_at`, compute `request_to_quote_seconds`, create `QuoteSendEvent` |
| `POST /api/quotes/draft` | Set `first_draft_created_at` if this is the first draft |

### 4.2 New Endpoints

| Endpoint | Method | Purpose | Response |
|---|---|---|---|
| `/api/requests/:id/deathclock` | GET | Live age for a single request | `{ age_seconds, age_label, color, is_complete }` |
| `/api/queue/sorted` | GET | Fetch queue sorted by age | List of requests with `deathclock` object embedded |
| `/api/requests/:id/mark-sent` | POST | Manual "sent" for offline quotes | Sets `quote_sent_at`, returns updated request |
| `/api/dashboard/deathclock-stats` | GET | Aggregate bucket counts | `{ green: N, yellow: N, orange: N, red: N, total_active: N }` |
| `/api/dashboard/trends` | GET | 7d and 30d averages | `{ avg_7d_hours, avg_30d_hours, bucket_history: [...] }` |

### 4.3 Polling Endpoint (Key Design Decision)

For the live-clocks-on-the-queue view, the frontend will poll:
```
GET /api/queue?sorted_by=age_asc&include_deathclock=true
```
This returns the full queue with a `deathclock` object embedded per request. The deathclock object is computed server-side:

```json
{
  "id": 42,
  "client_name": "Jane Doe",
  "request_created_at": "2026-05-25T14:30:00Z",
  "status": "active",
  "deathclock": {
    "age_seconds": 28800,
    "age_label": "8h",
    "color": "green",
    "is_complete": false,
    "frozen": false
  }
}
```

Color computation is done server-side so the frontend only needs to display.

---

## 5. Frontend Changes

### 5.1 Deathclock Component

Build a reusable `DeathclockBadge` component:

```
[DeathclockBadge]
- Props: { ageSeconds, color, isComplete, frozen }
- Renders: time label + color-coded border/shim on parent card
- Movement/pulse animation at yellow, orange, red thresholds
- Frozen (no animation) when isComplete or frozen
```

### 5.2 Where It Renders

1. **Request Queue Cards** (primary): Top-right corner of each card. Card border gets a left-side color strip matching the clock color.
2. **Request Detail Header**: Larger badge in the header area. Includes breakdown: "Request age: 3d 4h | Quote creation lag: 1d 2h | Send lag: 2d 2h".
3. **Team Dashboard / Analytics Panel**: Aggregate view showing a bar or donut chart of bucket counts (green/yellow/orange/red). Below that: 7d/30d average trend line.

### 5.3 Color Logic (Frontend Helper)

```javascript
function getDeathclockColor(ageSeconds) {
  if (ageSeconds < 24 * 3600) return 'green';       // < 24h
  if (ageSeconds < 48 * 3600) return 'yellow';      // 24-48h
  if (ageSeconds < 72 * 3600) return 'orange';      // 48-72h
  return 'red';                                      // > 72h
}

function getDeathclockLabel(ageSeconds) {
  const hours = ageSeconds / 3600;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 10) return `${days.toFixed(1)}d`;
  const wholeDays = Math.floor(days);
  const remainingHours = Math.round(hours % 24);
  if (days > 90) return '99+ days';
  return `${wholeDays}d ${remainingHours}h`;
}
```

### 5.4 Sort-by-Age

Add a sort toggle to the queue view:
- "Oldest First" (default for the deathclock view mode)
- "Newest First"
- Existing sort options remain available

Implement as a URL query param: `?sort=age_asc` or `?sort=age_desc`.

### 5.5 Polling Strategy

- Poll the queue endpoint every **60 seconds** when the queue page is visible
- Use `requestAnimationFrame` or `setInterval` with visibility detection (pause when tab hidden)
- The deathclock badge updates its displayed `age_label` client-side between polls by incrementing a local counter so the tick feels live even between server calls
- On page focus, immediately trigger a fresh poll

### 5.6 Accessibility

- Color is NOT the only indicator. The `age_label` text shows numeric time.
- Card border color is accompanied by a small colored dot icon with an `aria-label` like "Age: 8 hours - within SLA"
- Yellow/orange/red cards get a subtle `title` attribute with urgency text

---

## 6. Performance Considerations

| Concern | Mitigation |
|---|---|
| **Polling overhead** | 60s interval, single endpoint returns all queue data. Estimated < 5ms per request for the age computation (`NOW() - created_at` is trivial). With ~50 active requests, this is negligible. |
| **Queue page load time** | Age is computed in the SQL query: `SELECT *, EXTRACT(EPOCH FROM (NOW() - request_created_at)) AS age_seconds`. Single query, no N+1. Add a partial index on `(status, request_created_at)` for active-only queries. |
| **Dashboard aggregate query** | Computed once per poll (60s). Use a materialized view or Redis cache with 60s TTL if the data volume grows beyond ~1000 requests. |
| **Write-path latency** | Setting `quote_sent_at` is a single column update on the send action. Negligible overhead (< 5ms). |
| **Concurrent users** | All operations are read-heavy. Writes only happen on quote send (a few per day per user). No lock contention. |

### Caching Strategy

- **Queue data**: No client-side cache (needs fresh ages). Browser cache disabled via `Cache-Control: no-cache`.
- **Dashboard aggregate stats**: Server-side cache in Redis/memory with 60s TTL. Invalidated on any quote-send event.
- **Trend data (7d/30d)**: Heavier query. Cache with 5-minute TTL. Recalculated on demand or via cron every hour.

---

## 7. Implementation Sequence

### Phase 1: Backend Data Model + Core Logic (Day 1-2)

1. Add database migration for new fields on the existing request/quote table
2. Add `QuoteSendEvent` migration
3. Update the "send quote" action handler to set timestamps and compute elapsed time
4. Add the "mark as sent" endpoint for offline quotes
5. Add the deathclock computation helper function
6. Modify the queue query to include `age_seconds`
7. Build the `/api/dashboard/deathclock-stats` endpoint
8. Run the backfill migration for existing open requests

### Phase 2: Frontend Deathclock Badge (Day 3-4)

1. Build the `DeathclockBadge` React component (or equivalent framework component)
2. Add the badge to the request queue card
3. Implement color-coded card border/strip
4. Add the sort-by-age toggle
5. Implement 60s polling with local tick interpolation
6. Add pulsing animation for yellow/orange/red thresholds

### Phase 3: Detail View + Dashboard (Day 5-6)

1. Add deathclock badge to request detail header
2. Add quote creation lag and send lag breakdown in detail view
3. Build the team dashboard aggregate view (bucket counts)
4. Add the 7d/30d trend chart
5. Add per-request historical time-to-send in completed quote detail view

### Phase 4: Polish + Edge Cases (Day 7)

1. Handle the 99+ day cap
2. Frozen badge for completed requests (no animation, static color)
3. Accessibility pass: aria-labels, color+text indicators
4. Manual "mark as sent" UI in the request detail view
5. Edge case: multiple quotes per request display
6. Edge case: reopened quote display

---

## 8. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Poll vs WebSocket** | Polling (60s) | No existing WebSocket infra. 60s polling is simple, reliable, and low overhead. Upgrade to WebSocket if polling becomes a bottleneck. |
| **Server-side vs client-side color** | Server-side | Color logic is trivial and cheap. Computing on server ensures consistency and makes API consumers simpler. |
| **Age computation: live vs stored** | Live (NOW() - created_at) | Stale cached ages would be confusing. The DB subtraction is a single arithmetic op per row. |
| **Backfill for old requests** | Start from real created_at if available | Honest signal. An old open request SHOULD show as red -- that's the point. |
| **One endpoint vs many** | Single queue endpoint with optional deathclock embedding | Fewer round trips, simpler frontend logic. |
| **Framework** | App-specific pattern (assumed React or similar) | Follow existing Cotiza patterns for components, API calls, and state management. |

---

## 9. Open Questions

1. Should the deathclock on the queue poll be a separate lightweight endpoint (ages only) rather than the full queue endpoint? -- Decision: keep it bundled. The queue is already being fetched; adding 10 bytes per item is free.
2. Should the 48h cross trigger an in-app notification? -- Decision: V1 visual only (pulse animation). Notifications are out of scope per requirements.
3. Cache invalidation for dashboard: poll-based or event-driven? -- Decision: Poll-based with 60s TTL. Simple, good enough for a dashboard that nobody stares at continuously.

---

## 10. Appendix: Example Flow

1. Customer request arrives at `2026-05-25 10:00:00 UTC`
2. `request_created_at` is set. Deathclock starts at 0h.
3. User opens queue at `2026-05-25 14:00:00 UTC`. API returns `age_seconds: 14400`, color: `green`, label: `4h`.
4. User creates first draft at `2026-05-26 09:00:00 UTC`. `first_draft_created_at` set. Creation lag = 23h.
5. User sends quote at `2026-05-26 11:00:00 UTC`. `quote_sent_at` set. `request_to_quote_seconds = 25h`. Color frozen at `yellow`. Label frozen at `1.0d`.
6. Dashboard updates. Active bucket loses one yellow. Completed metric recorded.