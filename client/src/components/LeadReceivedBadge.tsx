/**
 * The standard "Lead received · N days ago" badge, shown in the top-right of every Requests row and
 * on the lead page header. Days are Chicago calendar days, the same count the server's workflow uses.
 */
const chicagoDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Whole Chicago calendar days from `from` to `now`, never negative. */
export function chicagoDaysAgo(from: number, now: number): number {
  const a = Date.parse(`${chicagoDay.format(new Date(from))}T12:00:00Z`);
  const b = Date.parse(`${chicagoDay.format(new Date(now))}T12:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86400_000));
}

export function daysAgoText(days: number): string {
  return days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`;
}

export default function LeadReceivedBadge({ createdAt, ageDays, now = Date.now() }: { createdAt: string | null; ageDays?: number | null; now?: number }) {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(created)) return null;
  const days = typeof ageDays === 'number' ? ageDays : chicagoDaysAgo(created, now);
  const date = new Date(created).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
  return (
    <span style={badge} title={`Lead received ${date}`} data-testid="lead-received-badge">
      <span style={label}>Lead received ·</span>
      <span style={value}>{daysAgoText(days)}</span>
      <span style={sub}>{date}</span>
    </span>
  );
}

const badge: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'baseline', columnGap: 6, rowGap: 0, flexWrap: 'wrap', maxWidth: 220,
  padding: '4px 10px', borderRadius: 10, background: '#eef2ff', color: '#1e3a8a', fontSize: 13, };
const label: React.CSSProperties = { fontWeight: 600 };
const value: React.CSSProperties = { fontWeight: 700 };
// The date sits on its own line under the age.
const sub: React.CSSProperties = { color: '#4b5563', fontSize: 12, flexBasis: '100%' };
