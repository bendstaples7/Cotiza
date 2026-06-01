import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ErrorResponse } from 'shared';
import { fetchDeathclockStats, fetchTrends, fetchPosts, fetchChannels, syncInstagramPosts } from '../api';
import type { DeathclockBucketCounts, DeathclockTrends } from '../api';
import type { Post, ChannelConnection } from 'shared';
import { getLabel } from '../components/DeathclockBadge';

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

  const [trends, setTrends] = useState<DeathclockTrends | null>(null);
  const [trendsLoading, setTrendsLoading] = useState(true);
  const [trendsError, setTrendsError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await fetchDeathclockStats();
      setStats(result);
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to load stats.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTrends = useCallback(async () => {
    try {
      setTrendsLoading(true);
      setTrendsError(null);
      const result = await fetchTrends();
      setTrends(result);
    } catch (err) {
      setTrendsError((err as ErrorResponse).message ?? 'Failed to load trends.');
    } finally {
      setTrendsLoading(false);
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadTrends(); }, [loadTrends]);

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

  // 300-second polling for trends with visibility detection and immediate poll on focus
  useEffect(() => {
    const TREND_POLL_INTERVAL_MS = 300_000;

    let pollInterval: ReturnType<typeof setInterval> | undefined;

    function startPolling() {
      stopPolling();
      pollInterval = setInterval(loadTrends, TREND_POLL_INTERVAL_MS);
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
      loadTrends();
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
  }, [loadTrends]);

  const handleBarClick = () => {
    navigate('/quotes/queue?sort=age_asc');
  };

  // ── Loading state ──
  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loadingContainerStyle}>
          <span style={spinnerStyle} />
          <p style={{ margin: '0.75rem 0 0', color: '#555' }}>Loading stats…</p>
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
        <h1 style={titleStyle}>Dashboard</h1>
        <div style={emptyStyle}>
          <p style={{ margin: 0, color: '#888' }}>No active requests.</p>
        </div>
      </div>
    );
  }

  const total = stats.totalActive;

  return (
    <div style={containerStyle}>
      <h1 style={titleStyle}>Dashboard</h1>
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

      {/* ── Trends Section ── */}
      <TrendsSection
        trends={trends}
        loading={trendsLoading}
        error={trendsError}
        onRetry={loadTrends}
      />

      {/* ── Social Media Summary ── */}
      <SocialSummary />
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

// ── TrendsSection Component ──

function TrendsSection({ trends, loading, error, onRetry }: {
  trends: DeathclockTrends | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading && !trends) {
    return (
      <div style={trendsContainerStyle}>
        <h2 style={trendsTitleStyle}>Trends</h2>
        <div style={trendsLoadingContainerStyle}>
          <span style={spinnerStyle} />
          <p style={{ margin: '0.75rem 0 0', color: '#555' }}>Loading trends…</p>
        </div>
      </div>
    );
  }

  if (error && !trends) {
    return (
      <div style={trendsContainerStyle}>
        <h2 style={trendsTitleStyle}>Trends</h2>
        <div role="alert" style={alertStyle}>{error}</div>
        <button type="button" onClick={onRetry} style={retryButtonStyle}>Retry</button>
      </div>
    );
  }

  if (!trends || trends.bucketHistory.length === 0) {
    return null;
  }

  const { avg7Days, avg30Days, bucketHistory } = trends;

  const SVG_W = 700;
  const SVG_H = 220;
  const MARGIN_L = 55;
  const MARGIN_R = 15;
  const MARGIN_T = 15;
  const MARGIN_B = 40;
  const CHART_W = SVG_W - MARGIN_L - MARGIN_R;
  const CHART_H = SVG_H - MARGIN_T - MARGIN_B;
  const BAR_SPACING = CHART_W / 7;
  const BAR_WIDTH = 38;

  const maxTotal = Math.max(...bucketHistory.map(d => d.green + d.yellow + d.orange + d.red), 1);

  const scaleH = (val: number) => (val / maxTotal) * CHART_H;

  return (
    <div style={trendsContainerStyle}>
      <h2 style={trendsTitleStyle}>Trends</h2>

      <div style={avgCardsRowStyle}>
        <div style={avgCardStyle}>
          <span style={avgLabelStyle}>7-Day Avg</span>
          <span style={avgValueStyle}>{getLabel(avg7Days)}</span>
        </div>
        <div style={avgCardStyle}>
          <span style={avgLabelStyle}>30-Day Avg</span>
          <span style={avgValueStyle}>{getLabel(avg30Days)}</span>
        </div>
      </div>

      <p style={chartSubtitleStyle}>SLA target: 24h &mdash; Bucket distribution per day (last 7 days)</p>

      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        style={svgStyle}
        role="img"
        aria-label={`Trend chart: 7-day bucket distribution. Green (within SLA), yellow (needs attention), orange (approaching deadline), red (over SLA). Data from ${bucketHistory[0].date} to ${bucketHistory[bucketHistory.length - 1].date}.`}
      >
        {[0, 1, 2, 3, 4].map(i => {
          const val = Math.round((maxTotal / 4) * i);
          const y = MARGIN_T + CHART_H - scaleH(val);
          return (
            <g key={i}>
              <line x1={MARGIN_L} y1={y} x2={SVG_W - MARGIN_R} y2={y} stroke="#e8e8e8" strokeWidth={1} />
              <text x={MARGIN_L - 8} y={y + 4} textAnchor="end" fontSize={11} fill="#888">{val}</text>
            </g>
          );
        })}

        {bucketHistory.map((day, i) => {
          const x = MARGIN_L + i * BAR_SPACING + (BAR_SPACING - BAR_WIDTH) / 2;
          const greenH = scaleH(day.green);
          const yellowH = scaleH(day.yellow);
          const orangeH = scaleH(day.orange);
          const redH = scaleH(day.red);
          const greenY = MARGIN_T + CHART_H - greenH;
          const yellowY = greenY - yellowH;
          const orangeY = yellowY - orangeH;
          const redY = orangeY - redH;

          const d = new Date(day.date);
          const dateLabel = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });

          return (
            <g key={day.date}>
              <rect x={x} y={greenY} width={BAR_WIDTH} height={Math.max(greenH, 0.5)} fill="#10b981" rx={2} />
              <rect x={x} y={yellowY} width={BAR_WIDTH} height={Math.max(yellowH, 0.5)} fill="#eab308" rx={2} />
              <rect x={x} y={orangeY} width={BAR_WIDTH} height={Math.max(orangeH, 0.5)} fill="#f97316" rx={2} />
              <rect x={x} y={redY} width={BAR_WIDTH} height={Math.max(redH, 0.5)} fill="#ef4444" rx={2} />
              <text x={x + BAR_WIDTH / 2} y={SVG_H - MARGIN_B + 14} textAnchor="middle" fontSize={10} fill="#666">
                {dateLabel}
              </text>
            </g>
          );
        })}

        <line x1={MARGIN_L} y1={MARGIN_T} x2={MARGIN_L} y2={MARGIN_T + CHART_H} stroke="#ccc" strokeWidth={1} />
      </svg>

      <div style={legendRowStyle}>
        {(['green', 'yellow', 'orange', 'red'] as const).map(key => (
          <div key={key} style={legendItemStyle}>
            <span style={{ ...legendDotStyle, background: BUCKET_COLORS[key] }} />
            <span style={legendLabelStyle}>{BUCKET_LABELS[key]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SocialSummary Component ──

function SocialSummary() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [channels, setChannels] = useState<ChannelConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Trigger Instagram sync first so fresh data is available before the fetch
    syncInstagramPosts()
      .catch((err) => {
        console.error('Instagram sync failed on dashboard load:', err);
        // Sync failure is ancillary — don't set fetchError, the main fetch might still succeed
      })
      .then(() => {
        if (cancelled) return;
        return Promise.all([
          fetchPosts().then((r) => setPosts(r.posts)).catch((err) => {
            console.error('Failed to fetch posts:', err);
            setFetchError(true);
          }),
          fetchChannels().then((r) => setChannels(r.channels)).catch((err) => {
            console.error('Failed to fetch channels:', err);
            setFetchError(true);
          }),
        ]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const drafts = posts.filter((p) => p.status === 'draft');
  const published = posts.filter((p) => p.status === 'published');
  const failed = posts.filter((p) => p.status === 'failed');
  const awaiting = posts.filter((p) => p.status === 'awaiting_approval');
  const connected = channels.filter((c) => c.status === 'connected');

  const socialStatBox: React.CSSProperties = {
    background: '#fff',
    borderRadius: 8,
    padding: '1.25rem',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    textAlign: 'center',
  };

  return (
    <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e0e0e0', padding: '1.5rem', marginTop: '1.5rem' }}>
      <h2 style={{ margin: '0 0 1rem', fontSize: '1.2rem', fontWeight: 600, color: '#061216' }}>
        Social Media Summary
      </h2>

      {loading ? (
        <p style={{ color: '#999', textAlign: 'center', padding: '1rem 0' }}>Loading stats...</p>
      ) : fetchError ? (
        <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: 8, padding: '0.75rem 1rem', fontSize: '0.9rem', color: '#cc0000' }}>
          ⚠️ Could not load social media data. <a href="/dashboard" style={{ color: '#cc0000', textDecoration: 'underline' }}>Retry</a>
        </div>
      ) : (
        <>
          {connected.length === 0 && (
            <div style={{ background: '#fff3e0', border: '1px solid #ffe0b2', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
              {channels.some((c) => c.status === 'expired') ? '📡 Instagram token expired.' : '📡 No channels connected.'}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem' }}>
            <div style={socialStatBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#0a1e24' }}>{posts.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Total Posts</div>
            </div>
            <div style={socialStatBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#ff9800' }}>{drafts.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Drafts</div>
            </div>
            <div style={socialStatBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#2196f3' }}>{awaiting.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Awaiting Review</div>
            </div>
            <div style={socialStatBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#4caf50' }}>{published.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Published</div>
            </div>
            <div style={socialStatBox}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#f44336' }}>{failed.length}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>Failed</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Trends Styles ──

const trendsContainerStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  border: '1px solid #e0e0e0',
  padding: '1.5rem',
  marginTop: '1.5rem',
};

const trendsTitleStyle: React.CSSProperties = {
  margin: '0 0 1rem',
  fontSize: '1.2rem',
  fontWeight: 600,
  color: '#061216',
};

const trendsLoadingContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem 0',
};

const avgCardsRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '1rem',
  marginBottom: '1rem',
};

const avgCardStyle: React.CSSProperties = {
  flex: 1,
  background: '#f9fafb',
  borderRadius: 8,
  border: '1px solid #e5e7eb',
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const avgLabelStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#888',
  fontWeight: 500,
};

const avgValueStyle: React.CSSProperties = {
  fontSize: '1.4rem',
  fontWeight: 700,
  color: '#061216',
};

const chartSubtitleStyle: React.CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '0.85rem',
  color: '#888',
};

const svgStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 700,
  display: 'block',
};

const legendRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '1.25rem',
  marginTop: '0.75rem',
  justifyContent: 'center',
};

const legendItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.35rem',
};

const legendDotStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  borderRadius: '50%',
  flexShrink: 0,
};

const legendLabelStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#555',
};