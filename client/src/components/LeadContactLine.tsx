import type { LeadContactStatus } from '../api';

/** "2 days ago", "3 hours ago", "just now". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** "Today", "Tomorrow", or "Thu, Nov 6" for a YYYY-MM-DD date in Chicago. */
export function formatDay(date: string, now: number = Date.now()): string {
  const today = chicagoDate(now);
  if (date === today) return 'Today';
  if (date === chicagoDate(now + 86_400_000)) return 'Tomorrow';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function chicagoDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

const SOURCE_LABEL: Record<string, string> = { quo: 'Quo', gmail: 'Gmail', jobber: 'Jobber', cotiza: 'Cotiza' };

export function sourceList(sources: string[]): string {
  return sources.map((s) => SOURCE_LABEL[s] ?? s).join(', ');
}

/** One-line last/next contact summary for queue cards. */
export default function LeadContactLine({ status }: { status: LeadContactStatus }) {
  const next = status.next;
  const nextColor = next.overdue ? '#b91c1c' : next.dueToday ? '#92400e' : '#555';
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 1rem', fontSize: '0.8rem', marginTop: '0.35rem' }}>
      <span style={{ color: '#555' }}>
        Last: {status.last ? `${status.last.label} · ${timeAgo(status.last.at)}` : 'none'}
        {status.unavailable.length > 0 && <span title={`Could not read ${sourceList(status.unavailable)}`}> (incomplete)</span>}
      </span>
      <span style={{ color: nextColor, fontWeight: next.overdue || next.dueToday ? 600 : 400 }}>
        Next: {formatDay(next.on)}{next.overdue ? ' · overdue' : ''}{next.source === 'suggested' ? ' (suggested)' : ''}
      </span>
    </div>
  );
}
