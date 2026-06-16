import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getPendingReviews } from '../api';
import ReviewBadge from '../components/review/ReviewBadge';
import type { PendingReviewItem } from '../api';

export default function ReviewQueuePage() {
  const navigate = useNavigate();
  const [reviews, setReviews] = useState<PendingReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReviews = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await getPendingReviews();
      setReviews(result);
    } catch (err) {
      setError((err as any).message ?? 'Failed to load pending reviews.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadReviews(); }, [loadReviews]);

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loadingContainerStyle}>
          <span style={spinnerStyle} />
          <p style={{ margin: '0.75rem 0 0', color: '#555' }}>Loading Jobber quotes…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <h1 style={titleStyle}>Jobber Quotes</h1>

      {error && (
        <div role="alert" style={alertStyle}>{error}</div>
      )}

      {reviews.length === 0 ? (
        <div style={emptyStyle}>
          <p style={{ margin: 0, color: '#888', fontSize: '1rem' }}>No Jobber quotes yet.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {reviews.map((review) => (
            <div
              key={review.id}
              style={cardStyle}
              onClick={() => navigate('/quotes/drafts/' + review.quoteDraftId + '?from=reviews')}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate('/quotes/drafts/' + review.quoteDraftId + '?from=reviews'); }}
              aria-label={`Review ${review.draftNumber} from ${review.submittedBy.name}`}
            >
              <div style={{ flex: 1, minWidth: 0, padding: '0.75rem 1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.95rem', color: '#061216' }}>
                    {review.jobberQuoteNumber ? `J-${review.jobberQuoteNumber}` : `D-${String(review.draftNumber).padStart(3, '0')}`}
                  </span>
                  <ReviewBadge status={review.status as any} />
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.3rem' }}>
                  <span style={{ fontSize: '0.85rem', color: '#555' }}>
                    Submitted by {review.submittedBy.name}
                  </span>
                </div>
                <div style={metaRowStyle}>
                  <span style={metaStyle}>
                    Submitted {new Date(review.submittedAt).toLocaleDateString()} · {new Date(review.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span style={metaStyle}>
                    ${review.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span style={metaStyle}>
                    Cycle {review.reviewCycle}
                  </span>
                </div>
              </div>
              <div style={chevronStyle}>›</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 800, margin: '0 auto' };
const titleStyle: React.CSSProperties = { margin: '0 0 1.25rem', fontSize: '1.5rem' };

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
  transition: 'box-shadow 0.15s',
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

const chevronStyle: React.CSSProperties = {
  padding: '0.75rem 1rem',
  fontSize: '1.3rem',
  color: '#ccc',
  borderLeft: '1px solid #e0e0e0',
  alignSelf: 'stretch',
  display: 'flex',
  alignItems: 'center',
};