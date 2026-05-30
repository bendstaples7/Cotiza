# Track Metrics: Request-to-Quote Deathclock

**Category:** Logging & Analytics  
**Roadmap Priority:** #1 (Score: 4, BV: 8, CE: 4)  
**Status:** Draft  
**Owner:** Product Manager  
**Dependencies:** None (standalone analytics feature)

---

## 1. Problem Statement

The Cotiza team has no visibility into how long it takes from a customer request landing to a quote being sent. This creates three issues:

1. **No SLA enforcement** -- team members let requests sit without accountability.
2. **No bottleneck detection** -- we cannot see where quotes stall (e.g., waiting for Ivan, waiting for materials calc, waiting for feedback).
3. **No urgency signal** -- a request from 3 weeks ago looks the same as a request from 30 minutes ago in the current UI.

Without live timing data, slow quotes erode customer trust and close rates silently.

---

## 2. Feature Description

Track the elapsed time between "request received" (first inbound contact / request creation) and "quote sent" (final quote delivered to customer). Surface this time as a visible, color-coded urgency indicator -- a "deathclock" -- that visually degrades (yellow, orange, red) as time passes without a quote being sent.

---

## 3. What Metrics to Track

### Primary Metric
| Metric | Definition | Unit |
|---|---|---|
| **Request-to-Quote Time** | Timestamp of request creation to timestamp of quote-sent event | Hours (decimal, e.g. 48.3h) |

### Supporting / Derived Metrics
| Metric | Definition | Why |
|---|---|---|
| **Current Age** | Elapsed time since request creation (live, ticking) | Drives the deathclock display |
| **Quote Creation Lag** | Time from request created to first draft quote created | Measures responsiveness |
| **Quote Send Lag** | Time from first draft to final send | Measures review/approval friction |
| **24h / 48h / 72h Rate** | % of quotes sent within 24, 48, 72 hours | Trend-based SLA tracking |

### Data Sources
- Request creation timestamp (from request intake system / Trello card creation date)
- Quote-sent timestamp (from "send quote" action in Cotiza)
- Draft-created timestamp (from first quote draft event)

---

## 4. The Deathclock Visual Concept

The deathclock is a visual urgency indicator displayed on every request/quote card in the queue. It consists of two elements:

### A. Color Band (Background / Border)
| Condition | Color | Meaning |
|---|---|---|
| 0 - 24 hours | Green (or no tint) | Within healthy SLA |
| 24 - 48 hours | Yellow | Getting warm -- needs attention |
| 48 - 72 hours | Orange | Hot -- risk of losing customer |
| > 72 hours | Red | Critical -- actively damaging reputation |

### B. Time Badge
A small badge showing elapsed time in a human-readable format:
- "2h" (under 24h)
- "1.5d" (over 24h, shows days + decimal)
- "3d 4h" (over 24h, shows days and hours)

### C. Animation / Ticking
- The badge updates in real time (websocket push or periodic polling, e.g. every 60s).
- At yellow/orange/red thresholds, the card border pulses gently to draw the eye.

---

## 5. Where It Sits in the UI

### 5a. Request Queue / Dashboard (Primary Location)
- Every request card in the main queue shows the deathclock badge in the top-right corner.
- The card border/background color shifts based on age.
- Cards can be sorted by age (oldest first) to triage the hottest requests.

### 5b. Individual Request / Quote Detail View
- The deathclock is displayed in the header area of the detail view.
- A trend line shows how this request's age compares to the team average.

### 5c. Team Dashboard / Analytics Panel
- Aggregate view: number of requests in each urgency bucket (green/yellow/orange/red).
- Rolling 7-day and 30-day average request-to-quote time.
- Per-team-member stats (average time to send for quotes they handled).

---

## 6. User Stories

### US-01: Queue color coding
As a quote preparer, I want to see at a glance which requests have been waiting the longest so I know what to work on next.

### US-02: Deathclock badge
As a quote preparer, I want to see exactly how long a request has been waiting (in hours/days) so I can triage accurately.

### US-03: Sort by age
As a quote preparer, I want to sort the queue by "oldest first" so the most urgent items surface to the top.

### US-04: Team lead oversight
As a team lead, I want to see the distribution of request ages across the team so I can rebalance work.

### US-05: Trend visibility
As a PM, I want a weekly trend report showing average request-to-quote time so I can track if we are improving.

### US-06: Per-user stats
As a PM, I want to see each team member's average quote turnaround time so I can identify coaching opportunities.

### US-07: Alert on crossing 48h
As a team lead, I want a visual alert when a request crosses 48h (turns orange) so I can intervene before it becomes critical.

---

## 7. Acceptance Criteria (Definition of Done)

The feature is "done" when:

1. [AC-01] Request-to-quote time is computed and stored for every completed quote (request created -> quote sent).
2. [AC-02] Each active (un-quoted) request displays a live deathclock badge showing elapsed time.
3. [AC-03] Color coding (green/yellow/orange/red) is applied to request cards based on the age thresholds in Section 4.
4. [AC-04] The queue can be sorted by age (ascending and descending).
5. [AC-05] The deathclock updates without full page refresh (polling or websocket, max 60s interval).
6. [AC-06] The team dashboard shows an aggregate breakdown: count of requests per color bucket.
7. [AC-07] Historical data: completed quotes show their "time to send" metric in the quote detail view.
8. [AC-08] Edge cases from Section 8 are handled without breaking the UI or displaying misleading values.
9. [AC-09] All deathclock-related UI passes a simple accessibility check (color is not the only indicator -- badge text also shows numeric time).
10. [AC-10] The feature does not degrade quote creation/send flow performance (measured: < 200ms added latency to any existing action).

---

## 8. Edge Cases

### 8.1 No quote sent yet (request still open)
- Deathclock continues ticking. Color transitions happen normally. No "completed" metric recorded until send.

### 8.2 Request is very old (years old / legacy data)
- Cap the display at "99+ days" and show the darkest red tint. Do not display absurd values like "8,760 hours". The system should treat any request older than 90 days as "stale" and handle gracefully.

### 8.3 Request received but quote was never started
- Deathclock runs from request timestamp. Color still transitions. This is a valid signal that a request was abandoned.

### 8.4 Quote sent outside the system (manual/offline)
- Provide a "mark as sent" action that records a timestamp so the metric is not permanently stuck.

### 8.5 Quote sent, then reopened and re-sent
- The primary metric uses the FIRST "quote sent" event. Track subsequent sends separately in an audit log.
- Show "original time: Xh, last sent: Yh ago" in the detail view.

### 8.6 Request created with historical timestamp (backfill)
- If a request is imported or created with a past timestamp, start the deathclock from that timestamp. Trust the data. If no timestamp exists, use "created_at" (now).

### 8.7 Multiple quotes for one request
- Track time to first quote send as the primary metric. List all child quotes with their individual send times in the detail view.

### 8.8 Timezone issues
- All timestamps stored in UTC. Display in the viewer's local timezone. Age calculation always uses UTC comparison.

### 8.9 Deathclock on a completed/closed request
- Stop the clock. Display the final elapsed time in a static badge (no pulsing, no color transitions). Color is frozen at the threshold reached at time of send.

---

## 9. Scope Boundaries

### In Scope
- Live deathclock badge on each request card in the queue
- Color-coded urgency tiers (green/yellow/orange/red)
- Sort-by-age on the queue
- Team dashboard with aggregate bucket counts
- Per-quote historical time-to-send in quote detail view
- Trend data (rolling 7d / 30d averages) in the analytics panel
- Backend timer logic (start on request create, stop on quote send)
- Backfill handling for existing open requests (start timer from "now" for legacy data)
- Accessibility: text labels in addition to color

### Out of Scope -- Explicitly NOT Included
- Automated SLA alerts via email/SMS/WhatsApp (future enhancement)
- Goal-setting or SLA configuration UI (hardcoded thresholds for v1)
- Individual user performance tracking / gamification (leaderboards, scores)
- Request-to-approval time (this tracks request-to-quote-sent only, not internal approval chains)
- Revenue impact correlation (e.g., "faster quotes = higher close rate")
- Trello card integration / yellow card visualization in Trello (the roadmap mentions Trello cards but this feature focuses on the Cotiza UI; Trello sync is separate)
- Export reports (CSV/PDF export of metrics -- future)
- Historical data migration for requests that predate this feature
- Mobile push notifications

---

## 10. Technical Considerations

### Data Model Changes
- Add `request_to_quote_seconds` (bigint, nullable) to the quote record.
- Add `quote_sent_at` (timestamp, nullable) to quote record.
- Add `first_draft_created_at` (timestamp, nullable) for derived lag metrics.
- Index on `request_created_at` for sorting.

### Performance
- Age calculation is a simple `NOW() - request_created_at` query -- negligible cost.
- Polling interval of 60s is acceptable. Websocket push is preferred if infrastructure exists.

### Backfill Strategy
- For open requests with no quote yet: start deathclock from "now" (age = 0) rather than the actual creation date, since we have no reliable history.
- For open requests with a draft but no send: calculate from request creation date if available.
- For completed quotes with no recorded send timestamp: mark as "no data" rather than guessing.

---

## 11. Success Metrics

| Metric | Target (v1) |
|---|---|
| % of active requests with deathclock displayed | 100% |
| Average request-to-quote time for new requests | Measure baseline |
| % of requests sent within 24h | Measure baseline |
| User adoption (at least one sort-by-age action per user per day) | > 80% of active users |

---

## 12. Open Questions (Answered)

1. Deathclock counts **all time** (weekends and nights included). Wall-clock time only.
2. Requests from all sources (email, Trello, WhatsApp, website) should eventually get timestamps. Currently only Jobber requests are tracked automatically. Non-Jobber sources are future work.
3. Ivan should **not** get alerts. Business user notifications are out of scope for v1.

## 13. Future Vision: Cotiza as Operations Platform

This feature is the first step toward Cotiza evolving from a quote/social tool into the central operations platform for Chicago Reno, eventually replacing Jobber.

**Current state:**
- Jobber handles lead intake and basic project management
- Trello adds visual kanban for team visibility
- Cotiza handles quotes and social media
- The result: massive manual duplication across all three systems

**Future state (Cotiza platform):**
- A unified visual board showing all leads through project phases
- Granular phase tracking (lead -> estimate -> booked -> materials -> in progress -> completed)
- Automated intake from website, Jobber sync, email parsing
- Team transparency without secondary tools
- The deathclock is the first step -- giving visibility into where work stalls

**Roadmap path:**
1. Deathclock + metrics (this feature)
2. Kanban board for quote pipeline
3. Full project phase tracking
4. Integration consolidation (replace manual cross-platform duplication)