import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DeathclockBadge from '../components/DeathclockBadge';
import type { ErrorResponse } from 'shared';
import { fetchManualRequests } from '../api';
import type { ManualRequestWithDeathclock } from '../api';

// ---------------------------------------------------------------------------
// Deathclock color → hex map (mirrors DeathclockBadge component)
// ---------------------------------------------------------------------------
const DEATHCLOCK_COLORS: Record<string, string> = {
  green: '#10b981',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
} as const;

/** Convert #rrggbb hex to "r, g, b" string for CSS custom properties. */
const hexToRgb = (hex: string): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RequestQueuePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [requests, setRequests] = useState<ManualRequestWithDeathclock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tick counter to trigger re-renders every second for live deathclock age
  const [tick, setTick] = useState(0);
  const lastFetchedAtRef = useRef(0);

  // 1-second tick — drives local age interpolation between polls
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Read sort from URL query param, default to 'age_asc'
  const sortParam = searchParams.get('sort');
  const currentSort: 'age_asc' | 'age_desc' =
    sortParam === 'age_desc' ? 'age_desc' : 'age_asc';

  const loadRequests = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await fetchManualRequests(currentSort);
      setRequests(result);
      lastFetchedAtRef.current = Date.now();
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to load request queue.');
    } finally {
      setLoading(false);
    }
  }, [currentSort]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  // 60-second polling with visibility detection and immediate poll on focus
  useEffect(() => {
    const POLL_INTERVAL_MS = 60_000;

    let pollInterval: ReturnType<typeof setInterval> | undefined;

    function startPolling() {
      stopPolling();
      pollInterval = setInterval(loadRequests, POLL_INTERVAL_MS);
    }

    function stopPolling() {
      if (pollInterval !== undefined) {
        clearInterval(pollInterval);
        pollInterval = undefined;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        startPolling();
      } else {
        stopPolling();
      }
    }

    function handleWindowFocus() {
      loadRequests();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    // Start polling only if the page is visible on mount
    if (document.visibilityState === 'visible') {
      startPolling();
    }

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [loadRequests]);

  const handleSortChange = (sort: 'age_asc' | 'age_desc') => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('sort', sort);
    navigate('?' + params.toString(), { replace: false });
  };

  // ── Loading state ──
  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loadingContainerStyle}>
          <span style={spinnerStyle} />
          <p style={{ margin: '0.75rem 0 0', color: '#555' }}>Loading request queue…</p>
        </div>
      </div>
    );
  }

  // Check if any card needs the pulsing glow animation
  const anyShouldPulse = requests.some(
    (r) => !r.deathclock.frozen && !r.deathclock.isComplete && ['yellow', 'orange', 'red'].includes(r.deathclock.color)
  );

  return (
    <div style={containerStyle}>
      {anyShouldPulse && (
        <style>{`
@keyframes dc-card-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--dc-card-rgb), 0.3); }
  50% { box-shadow: 0 0 8px 2px rgba(var(--dc-card-rgb), 0.15); }
}
`}</style>
      )}
      <h1 style={titleStyle}>Request Queue</h1>

      {/* Sort toggle */}
      <div style={sortToggleContainerStyle}>
        <button
          type="button"
          style={currentSort === 'age_asc' ? sortToggleActiveStyle : sortToggleInactiveStyle}
          onClick={() => handleSortChange('age_asc')}
          aria-label="Sort oldest first"
        >
          Oldest First
        </button>
        <button
          type="button"
          style={currentSort === 'age_desc' ? sortToggleActiveStyle : sortToggleInactiveStyle}
          onClick={() => handleSortChange('age_desc')}
          aria-label="Sort newest first"
        >
          Newest First
        </button>
      </div>

      {error && (
        <div role="alert" style={alertStyle}>{error}</div>
      )}

      {requests.length === 0 ? (
        <div style={emptyStyle}>
          <p style={{ margin: 0, color: '#888' }}>No pending requests in the queue.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {requests.map((req) => {
            const colorHex = DEATHCLOCK_COLORS[req.deathclock.color] ?? '#10b981';
            const liveAge = req.deathclock.ageSeconds + Math.floor((Date.now() - lastFetchedAtRef.current) / 1000);
            const shouldPulse = !req.deathclock.frozen && !req.deathclock.isComplete &&
              (req.deathclock.color === 'yellow' || req.deathclock.color === 'orange' || req.deathclock.color === 'red');
            return (
              <div
                key={req.id}
                style={{
                  ...cardStyle,
                  borderLeft: `4px solid ${colorHex}`,
                  ...(shouldPulse ? { '--dc-card-rgb': hexToRgb(colorHex), animation: 'dc-card-glow 2s ease-in-out infinite' } as React.CSSProperties : {}),
                }}
                onClick={() => navigate('/quotes?createFromRequestId=' + encodeURIComponent(req.id))}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate('/quotes?createFromRequestId=' + encodeURIComponent(req.id)); }}
                aria-label={`Request from ${req.customerName}`}
              >
                <div style={cardInnerStyle}>
                  <div style={cardHeaderStyle}>
                    <span style={customerNameStyle}>
                      {req.customerName}
                    </span>
                    <DeathclockBadge
                      ageSeconds={liveAge}
                      color={req.deathclock.color}
                      isComplete={req.deathclock.isComplete}
                      frozen={req.deathclock.frozen}
                      compact
                    />
                  </div>
                  <p style={descriptionStyle}>
                    {req.serviceDescription.length > 120
                      ? req.serviceDescription.slice(0, 120) + '…'
                      : req.serviceDescription}
                  </p>
                  <div style={metaRowStyle}>
                    <span style={metaStyle}>
                      Created {new Date(req.createdAt).toLocaleDateString()}
                    </span>
                    {req.jobberRequestId && (
                      <span style={metaStyle}>
                        Jobber #{decodeJobberId(req.jobberRequestId)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 800, margin: '0 auto' };
const titleStyle: React.CSSProperties = { margin: '0 0 1.25rem', fontSize: '1.5rem' };

const sortToggleContainerStyle: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid #d0d0d0',
  borderRadius: 6,
  overflow: 'hidden',
  marginBottom: '1rem',
};

const sortToggleBaseStyle: React.CSSProperties = {
  border: 'none',
  padding: '0.4rem 0.9rem',
  fontSize: '0.85rem',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background 0.15s, color 0.15s',
  outline: 'none',
} as const;

const sortToggleActiveStyle: React.CSSProperties = {
  ...sortToggleBaseStyle,
  background: '#00a89d',
  color: '#fff',
};

const sortToggleInactiveStyle: React.CSSProperties = {
  ...sortToggleBaseStyle,
  background: '#fff',
  color: '#555',
};

const loadingContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '3rem 0',
};

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 28,
  height: 28,
  border: '3px solid #e0e0e0',
  borderTopColor: '#00a89d',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};

const alertStyle: React.CSSProperties = {
  background: '#fdecea',
  color: '#611a15',
  padding: '0.75rem 1rem',
  borderRadius: 4,
  marginBottom: '1rem',
};

const emptyStyle: React.CSSProperties = {
  textAlign: 'center',
  padding: '3rem 1rem',
  background: '#fff',
  borderRadius: 8,
  border: '1px solid #e0e0e0',
};

const cardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  overflow: 'hidden',
  cursor: 'pointer',
};

const cardInnerStyle: React.CSSProperties = {
  flex: 1,
  padding: '0.75rem 1rem',
  minWidth: 0,
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  marginBottom: '0.25rem',
};

const customerNameStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '0.95rem',
  color: '#061216',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const descriptionStyle: React.CSSProperties = {
  margin: '0 0 0.4rem',
  fontSize: '0.9rem',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const metaRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  alignItems: 'center',
  flexWrap: 'wrap',
};

const metaStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: '#888',
};

/** Decode a base64 Jobber GraphQL ID and extract the numeric request ID for display. */
function decodeJobberId(id: string): string {
  try {
    const decoded = atob(id);
    // Format: gid://Jobber/Request/29995593
    const parts = decoded.split('/');
    return parts[parts.length - 1] || id.slice(0, 12);
  } catch {
    return id.slice(0, 12);
  }
}