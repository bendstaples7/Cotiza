import type { DeathclockColor, DeathclockState } from 'shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECONDS_IN_MINUTE = 60;
const SECONDS_IN_HOUR = 3600;
const SECONDS_IN_DAY = 86400;
const SECONDS_IN_90_DAYS = 90 * SECONDS_IN_DAY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a Date or ISO-8601 string to a Date object. */
function toDate(value: Date | string): Date {
  return typeof value === 'string' ? new Date(value) : value;
}

/**
 * Map elapsed seconds to a color bucket.
 *
 *   green  →  < 24 hours
 *   yellow →  < 48 hours
 *   orange →  < 72 hours
 *   red    →  >= 72 hours
 */
function getColor(ageSeconds: number): DeathclockColor {
  if (ageSeconds < 24 * SECONDS_IN_HOUR) return 'green';
  if (ageSeconds < 48 * SECONDS_IN_HOUR) return 'yellow';
  if (ageSeconds < 72 * SECONDS_IN_HOUR) return 'orange';
  return 'red';
}

/**
 * Format elapsed seconds into a human-readable label.
 *
 *   < 60 min   →  "Xm"        (e.g. "45m")
 *   < 24 hours →  "Xh"        (e.g. "8h")
 *   < 7 days   →  "X.Xd"      (e.g. "2.5d")
 *   < 90 days  →  "Xd Xh"     (e.g. "5d 12h")
 *   >= 90 days →  "99+ days"
 */
function getLabel(ageSeconds: number): string {
  // Cap at 90 days for display
  if (ageSeconds >= SECONDS_IN_90_DAYS) {
    return '99+ days';
  }

  const totalMinutes = ageSeconds / SECONDS_IN_MINUTE;
  const totalHours = ageSeconds / SECONDS_IN_HOUR;
  const totalDays = totalHours / 24;

  // < 60 minutes
  if (totalMinutes < 60) {
    const mins = Math.ceil(totalMinutes);
    return `${Math.max(1, mins)}m`;
  }

  // < 24 hours
  if (totalHours < 24) {
    return `${Math.round(totalHours)}h`;
  }

  // < 7 days — one decimal place (floor-based to prevent rounding across 7-day boundary)
  if (totalDays < 7) {
    return `${(Math.floor(totalDays * 10) / 10).toFixed(1)}d`;
  }

  // < 90 days — whole days + remaining hours
  const wholeHours = Math.floor(totalHours);
  const wholeDays = Math.floor(wholeHours / 24);
  const remainingHours = wholeHours % 24;
  return `${wholeDays}d ${remainingHours}h`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the visual state of a deathclock badge for a customer request.
 *
 * - Live age is computed as `NOW() - requestCreatedAt` when `quoteSentAt` is
 *   not provided.
 * - When `quoteSentAt` is provided, the age freezes at the elapsed time
 *   between request creation and quote send (`isComplete = true`, `frozen = true`).
 * - Age is capped at 90 days for display purposes (label becomes "99+ days").
 *
 * @param requestCreatedAt - When the customer request was created (Date or ISO string).
 * @param quoteSentAt      - When the quote was sent to the customer (optional).
 *                           When provided the clock freezes at this point in time.
 * @returns The computed DeathclockState for display.
 */
export function computeDeathclock(
  requestCreatedAt: Date | string,
  quoteSentAt?: Date | string | null,
  precomputedAgeSeconds?: number,
): DeathclockState {
  const created = toDate(requestCreatedAt);

  let ageSeconds: number;
  let isComplete: boolean;
  let frozen: boolean;

  if (quoteSentAt) {
    // Frozen: age is the delta between request creation and quote send
    const sent = toDate(quoteSentAt);
    ageSeconds = Math.floor((sent.getTime() - created.getTime()) / 1000);
    isComplete = true;
    frozen = true;
  } else if (precomputedAgeSeconds !== undefined) {
    // Use pre-computed age (from SQL, matching the list query's age_seconds)
    ageSeconds = precomputedAgeSeconds;
    isComplete = false;
    frozen = false;
  } else {
    // Live: age = NOW() - requestCreatedAt
    const now = new Date();
    ageSeconds = Math.floor((now.getTime() - created.getTime()) / 1000);
    isComplete = false;
    frozen = false;
  }

  // Clamp negative age (future requestCreatedAt) to zero
  if (ageSeconds < 0) {
    ageSeconds = 0;
  }

  // Cap at 90 days for display — prevents absurd values in the API response
  if (ageSeconds > SECONDS_IN_90_DAYS) {
    ageSeconds = SECONDS_IN_90_DAYS;
  }

  const color = getColor(ageSeconds);
  const ageLabel = getLabel(ageSeconds);

  return { ageSeconds, ageLabel, color, isComplete, frozen };
}