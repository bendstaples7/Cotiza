import type { CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeathclockBadgeProps {
  ageSeconds: number;
  color: 'green' | 'yellow' | 'orange' | 'red';
  isComplete: boolean;
  frozen: boolean;
  /** Optional: compact mode for queue cards vs expanded for detail view */
  compact?: boolean;
  /** Additional CSS class or style override */
  style?: CSSProperties;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLOR_MAP: Record<string, string> = {
  green: '#10b981',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
} as const;

const DOT_SIZE_COMPACT = 8;
const DOT_SIZE_NORMAL = 12;
const FONT_SIZE_COMPACT = '0.75rem';
const FONT_SIZE_NORMAL = '0.85rem';

const SECONDS_IN_MINUTE = 60;
const SECONDS_IN_HOUR = 3600;
const SECONDS_IN_DAY = 86400;
const SECONDS_IN_90_DAYS = 90 * SECONDS_IN_DAY;

const PULSE_DURATION = '2s';

/** Urgency text for screen readers — color is never the only indicator. */
export function getUrgencyText(color: string, isComplete: boolean, frozen: boolean): string {
  if (isComplete || frozen) return 'completed — no longer tracking';
  switch (color) {
    case 'green':  return 'within SLA';
    case 'yellow': return 'needs attention — approaching SLA limit';
    case 'orange': return 'approaching deadline — overdue soon';
    case 'red':    return 'over SLA deadline';
    default:       return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Client-side label formatter (fallback, mirrors server logic)
// ---------------------------------------------------------------------------

/**
 * Format elapsed seconds into a human-readable label.
 *
 *   < 60 min   →  "Xm"        (e.g. "45m")
 *   < 24 hours →  "Xh"        (e.g. "8h")
 *   < 7 days   →  "X.Xd"      (e.g. "2.5d")
 *   < 90 days  →  "Xd Xh"     (e.g. "5d 12h")
 *   >= 90 days →  "99+ days"
 */
export function getLabel(ageSeconds: number): string {
  if (ageSeconds >= SECONDS_IN_90_DAYS) {
    return '99+ days';
  }

  const totalMinutes = ageSeconds / SECONDS_IN_MINUTE;
  const totalHours = ageSeconds / SECONDS_IN_HOUR;
  const totalDays = totalHours / 24;

  if (totalMinutes < 60) {
    const mins = Math.ceil(totalMinutes);
    return `${Math.max(1, mins)}m`;
  }

  if (totalHours < 24) {
    return `${Math.round(totalHours)}h`;
  }

  if (totalDays < 7) {
    return `${(Math.floor(totalDays * 10) / 10).toFixed(1)}d`;
  }

  const wholeHours = Math.floor(totalHours);
  const wholeDays = Math.floor(wholeHours / 24);
  const remainingHours = wholeHours % 24;
  return `${wholeDays}d ${remainingHours}h`;
}

// ---------------------------------------------------------------------------
// Keyframe style sheet (injected once)
// ---------------------------------------------------------------------------

const pulseKeyframes = `
@keyframes dc-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--dc-rgb), 0.4); }
  50% { box-shadow: 0 0 0 4px rgba(var(--dc-rgb), 0.1); }
}
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DeathclockBadge({
  ageSeconds,
  color,
  isComplete,
  frozen,
  compact = false,
  style,
}: DeathclockBadgeProps) {
  const hexColor = COLOR_MAP[color];
  const dotSize = compact ? DOT_SIZE_COMPACT : DOT_SIZE_NORMAL;
  const fontSize = compact ? FONT_SIZE_COMPACT : FONT_SIZE_NORMAL;
  const shouldAnimate = !frozen && !isComplete && (color === 'yellow' || color === 'orange' || color === 'red');

  // Convert hex to decimal RGB for CSS custom property used in the animation
  const rgb = hexToRgb(hexColor);

  // Container row
  const containerStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: compact ? 4 : 6,
    padding: compact ? '1px 6px' : '2px 10px',
    borderRadius: 4,
    background: hexToRgba(hexColor, 0.1),
    ...style,
  };

  // Colored dot
  const dotStyle: CSSProperties = {
    width: dotSize,
    height: dotSize,
    borderRadius: '50%',
    backgroundColor: hexColor,
    flexShrink: 0,
    ...(shouldAnimate && rgb ? { animation: `dc-pulse ${PULSE_DURATION} ease-in-out infinite`, '--dc-rgb': `${rgb.r}, ${rgb.g}, ${rgb.b}` } : {}),
  };

  // Label
  const labelStyle: CSSProperties = {
    fontSize,
    color: '#333',
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
  };

  // Color accent for the age label itself (applies color text tint)
  const accentStyle: CSSProperties = {
    color: hexColor,
    fontWeight: 500,
  };

  // Lock/frozen indicator
  const showLock = frozen || isComplete;
  const lockStyle: CSSProperties = {
    fontSize: compact ? '0.65rem' : '0.75rem',
    lineHeight: 1,
    marginLeft: 2,
    opacity: 0.7,
  };

  // Use server-provided ageLabel if passed via ageSeconds in a real flow;
  // for this component, we compute it client-side
  const label = getLabel(ageSeconds);
  const urgency = getUrgencyText(color, isComplete, frozen);
  const ariaLabel = `Request age: ${label} — ${urgency}`;
  const titleText = isComplete || frozen
    ? `Request age: ${label} (frozen)`
    : `Request age: ${label} — ${urgency}`;

  return (
    <>
      {shouldAnimate && (
        <style>{pulseKeyframes}</style>
      )}
      <div
        style={containerStyle}
        role="img"
        aria-label={ariaLabel}
        title={titleText}
      >
        <span
          style={dotStyle}
          aria-hidden="true"
        />
        <span style={labelStyle}>
          <span style={accentStyle}>{label}</span>
          {showLock && <span style={lockStyle} aria-label="Frozen">🔒</span>}
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Color utility functions
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}
