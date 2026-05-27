import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ErrorResponse } from 'shared';
import { fetchDeathclockStats } from '../api';
import type { DeathclockBucketCounts } from '../api';

const BUCKET_COLORS: Record<string, string> = {
  green: '#10b981',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
};

const BUCKET_LABELS: Record<string, string> = {
  green: 'Green',
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red',
};

const BUCKET_ORDER = ['green', 'yellow', 'orange', 'red'] as const;

export default function DeathclockDashboardPage() {
  const navigate = useNavigate();

  const [stats, setStats] = useState<DeathclockBucketCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await fetchDeathclockStats();
      setStats(result);
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to load deathclock stats.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  // 60-second polling with visibility detection and immediate poll on focus
  useEffect(() => {
    const POLL_INTERVAL_MS = 60_000;

    let pollInterval: ReturnType<typeof setInterval> | undefined;

    function startPolling() {
      stopPolling();
      pollInterval = setInterval(loadStats, POLL_INTERVAL_MS);
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
      loadStats();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    if (document.visibilityState === 'visible') {
      startPolling();
    }

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [loadStats]);

  const handleBarClick = () => {
    navigate('/quotes/queue?sort=age_asc');
  };

  // ── Loading state ──
  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loadingContainerStyle}>
          <span style={spinnerStyle} />
          <p style={{ margin: '0.75rem 0 0', color: '#555' }}>Loading deathclock stats…</p>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error) {
    return (
      <div style={containerStyle}>
        <div role="alert" style={alertStyle}>{error}</div>
        <button
          type="button"
          onClick={loadStats}
          style={retryButtonStyle}
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Empty state ──
  if (!stats || stats.totalActive === 0) {
    return (
      <div style={containerStyle}>
        <h1 style={titleStyle}>Deathclock Dashboard</h1>
        <div style={emptyStyle}>
          <p style={{ margin: 0, color: '#888' }}>No active requests.</p>
        </div>
      </div>
    );
  }

  const total = stats.totalActive;

  return (
    <div style={containerStyle}>
      <h1 style={titleStyle}>Deathclock Dashboard</h1>
      <p style={summaryStyle}>{total} active request{total !== 1 ? 's' : ''}</p>

      <div style={chartContainerStyle}>
        {BUCKET_ORDER.map((key) => {
          const count = stats[key];
          const color = BUCKET_COLORS[key];
          const label = BUCKET_LABELS[key];
          const pct = total > 0 ? (count / total) * 100 : 0;

          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              onClick={handleBarClick}
              onKeyDown={(e) => { if (e.key === 'Enter') handleBarClick(); }}
              aria-label={`${label}: ${count} requests, ${Math.round(pct)}%`}
              style={barRowStyle}
            >
              <div style={barLabelStyle}>
                <span style={{ ...dotStyle, background: color }} />
                <span>{label}</span>
              </div>
              <div style={barTrackStyle}>
                <div
                  style={{
                    ...barFillStyle,
                    width: Math.max(pct, count > 0 ? 2 : 0) + '%',
                    background: color,
                  }}
                />
              </div>
              <div style={barMetaStyle}>
                <span style={barCountStyle}>{count}</span>
                <span style={barPctStyle}>{Math.round(pct)}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 800, margin: '0 auto' };
const titleStyle: React.CSSProperties = { margin: '0 0 0.25rem', fontSize: '1.5rem' };
const summaryStyle: React.CSSProperties = { margin: '0 0 1.5rem', fontSize: '1rem', color: '#666' };

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

const retryButtonStyle: React.CSSProperties = {
  background: '#00a89d',
  color: '#fff',
  border: 'none',
  padding: '0.5rem 1rem',
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '0.9rem',
};

const emptyStyle: React.CSSProperties = {
  textAlign: 'center',
  padding: '3rem 1rem',
  background: '#fff',
  borderRadius: 8,
  border: '1px solid #e0e0e0',
};

const chartContainerStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  border: '1px solid #e0e0e0',
  padding: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const barRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  cursor: 'pointer',
  padding: '0.35rem 0',
  borderRadius: 4,
  transition: 'background 0.15s',
};

const barLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  width: 80,
  fontSize: '0.9rem',
  fontWeight: 500,
  color: '#333',
  flexShrink: 0,
};

const dotStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  borderRadius: '50%',
  flexShrink: 0,
};

const barTrackStyle: React.CSSProperties = {
  flex: 1,
  height: 22,
  background: '#f0f0f0',
  borderRadius: 4,
  overflow: 'hidden',
};

const barFillStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 4,
  transition: 'width 0.3s ease',
  minWidth: 2,
};

const barMetaStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  width: 90,
  flexShrink: 0,
  justifyContent: 'flex-end',
};

const barCountStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '0.95rem',
  color: '#061216',
  minWidth: 28,
  textAlign: 'right',
};

const barPctStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#888',
  minWidth: 40,
  textAlign: 'right',
};