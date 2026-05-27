import { useState, useEffect, useCallback } from 'react';
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RequestQueuePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [requests, setRequests] = useState<ManualRequestWithDeathclock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to load request queue.');
    } finally {
      setLoading(false);
    }
  }, [currentSort]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

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

  return (
    <div style={containerStyle}>
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
            return (
              <div
                key={req.id}
                style={{
                  ...cardStyle,
                  borderLeft: `4px solid ${colorHex}`,
                }}
                onClick={() => navigate('/quotes')}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate('/quotes'); }}
                aria-label={`Request from ${req.customerName}`}
              >
                <div style={cardInnerStyle}>
                  <div style={cardHeaderStyle}>
                    <span style={customerNameStyle}>
                      {req.customerName}
                    </span>
                    <DeathclockBadge
                      ageSeconds={req.deathclock.ageSeconds}
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