import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getReview, completeReview } from '../api';
import type { ReviewDetailData } from '../api';
import ReviewBadge from '../components/review/ReviewBadge';
import ReviewLineItemFeedbackPanel from '../components/review/ReviewLineItemFeedbackPanel';
import PushToJobberButton from '../components/review/PushToJobberButton';

export default function ReviewQuotePage() {
  const { reviewId } = useParams<{ reviewId: string }>();
  const navigate = useNavigate();

  const [data, setData] = useState<ReviewDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestChangesNotes, setRequestChangesNotes] = useState('');
  const [showRequestChangesForm, setShowRequestChangesForm] = useState(false);

  const loadReview = useCallback(async () => {
    if (!reviewId) return;
    try {
      setLoading(true);
      setError(null);
      const result = await getReview(reviewId);
      setData(result);
    } catch (err) {
      setError((err as any).message ?? 'Failed to load review.');
    } finally {
      setLoading(false);
    }
  }, [reviewId]);

  useEffect(() => { loadReview(); }, [loadReview]);

  const handlePush = async () => {
    if (!reviewId) return;
    try {
      await completeReview(reviewId, 'push_to_jobber');
      await loadReview();
    } catch (err) {
      throw err;
    }
  };

  const handleRequestChanges = async () => {
    if (!reviewId) return;
    try {
      await completeReview(reviewId, 'changes_requested', requestChangesNotes || undefined);
      setShowRequestChangesForm(false);
      setRequestChangesNotes('');
      await loadReview();
    } catch (err) {
      throw err;
    }
  };

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loadingContainerStyle}>
          <span style={spinnerStyle} />
          <p style={{ margin: '0.75rem 0 0', color: '#555' }}>Loading review detail…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={containerStyle}>
        <div role="alert" style={alertStyle}>
          {error || 'Review not found.'}
        </div>
        <button onClick={() => navigate('/quotes/reviews')} style={backBtnStyle}>
          ← Back to Review Queue
        </button>
      </div>
    );
  }

  const { review, quote, feedback, previousSnapshots } = data;
  const lineItems = (quote as any).lineItems ?? [];
  const totalValue = lineItems.reduce(
    (sum: number, item: any) => sum + (item.quantity || 0) * (item.unitPrice || 0),
    0,
  );
  const isCompleted = review.status === 'push_to_jobber' || review.status === 'changes_requested';

  return (
    <div style={containerStyle}>
      {/* Back link */}
      <button onClick={() => navigate('/quotes/reviews')} style={backBtnStyle}>
        ← Back to Review Queue
      </button>

      {/* Header */}
      <div style={headerStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
            <h1 style={{ margin: 0, fontSize: '1.3rem' }}>
              {quote.clientName ? `${quote.clientName} — ` : ''}
              {(quote as any).jobberQuoteNumber ? `J-${(quote as any).jobberQuoteNumber}` : `D-${String((quote as any).draftNumber ?? '').padStart(3, '0')}`}
            </h1>
            <ReviewBadge status={review.status as any} />
          </div>
          <p style={{ margin: '0.25rem 0 0', color: '#666', fontSize: '0.9rem' }}>
            Submitted {new Date(review.submittedAt).toLocaleString()} · Cycle {(review as any).reviewCycle ?? 1}
          </p>
        </div>

        {/* Action buttons */}
        {!isCompleted && (
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
            <PushToJobberButton
              onPush={handlePush}
              onRequestChanges={async () => setShowRequestChangesForm(true)}
              hasFeedback={feedback.length > 0}
            />
          </div>
        )}
      </div>

      {/* Completed state banner */}
      {isCompleted && (
        <div style={{
          background: review.status === 'push_to_jobber' ? '#f0fdf4' : '#fff7ed',
          border: `1px solid ${review.status === 'push_to_jobber' ? '#bbf7d0' : '#fdba74'}`,
          color: review.status === 'push_to_jobber' ? '#16a34a' : '#ea580c',
          padding: '0.75rem 1rem',
          borderRadius: 6,
          marginBottom: '1rem',
          fontSize: '0.9rem',
          fontWeight: 600,
        }}>
          {review.status === 'push_to_jobber'
            ? '✅ Quote has been pushed to Jobber.'
            : 'Changes have been requested.'}
          {review.notes && <span style={{ fontWeight: 400, display: 'block', marginTop: '0.25rem' }}>{review.notes}</span>}
        </div>
      )}

      {/* Main layout: left panel + right panel */}
      <div style={splitLayoutStyle}>
        {/* Left panel: Quote details */}
        <div style={leftPanelStyle}>
          <div style={sectionCardStyle}>
            <h2 style={sectionTitleStyle}>Line Items & Pricing</h2>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Item</th>
                  <th style={thStyle}>Qty</th>
                  <th style={thStyle}>Unit Price</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ ...tdStyle, textAlign: 'center', color: '#888', fontStyle: 'italic' }}>
                      No line items
                    </td>
                  </tr>
                ) : (
                  lineItems.map((item: any) => (
                    <tr key={item.id}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 500, fontSize: '0.9rem' }}>{item.productName}</div>
                        {item.description && (
                          <div style={{ fontSize: '0.78rem', color: '#888', marginTop: '0.15rem' }}>{item.description}</div>
                        )}
                      </td>
                      <td style={tdStyle}>{item.quantity}</td>
                      <td style={tdStyle}>${(item.unitPrice ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                        ${((item.quantity ?? 0) * (item.unitPrice ?? 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, borderTop: '2px solid #333' }}>
                    Total
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, borderTop: '2px solid #333' }}>
                    ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Terms section */}
          {(quote as any).customerNote && (
            <div style={sectionCardStyle}>
              <h2 style={sectionTitleStyle}>Customer Note / Terms</h2>
              <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5, color: '#333', whiteSpace: 'pre-wrap' }}>
                {(quote as any).customerNote}
              </p>
            </div>
          )}

          {/*
          * Review History
          */}
          {previousSnapshots.length > 0 && (
            <div style={sectionCardStyle}>
              <h2 style={sectionTitleStyle}>Review History</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {previousSnapshots.map((snap, idx) => (
                  <div key={snap.id} style={historyItemStyle}>
                    <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                      Cycle {previousSnapshots.length - idx}
                    </span>
                    <span style={{ fontSize: '0.8rem', color: '#888' }}>
                      {new Date(snap.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right panel: Feedback */}
        <div style={rightPanelStyle}>
          <ReviewLineItemFeedbackPanel
            lineItems={lineItems}
            feedback={feedback}
            reviewId={review.id}
            readOnly={isCompleted}
          />
        </div>
      </div>

      {/* Request Changes form */}
      {showRequestChangesForm && (
        <div style={overlayStyle} onClick={() => setShowRequestChangesForm(false)}>
          <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>Request Changes</h3>
            <p style={{ fontSize: '0.9rem', color: '#555', lineHeight: 1.5, marginBottom: '0.75rem' }}>
              Provide notes about what needs to change. The preparer will be able to modify the quote and re-submit for review.
            </p>
            <textarea
              value={requestChangesNotes}
              onChange={(e) => setRequestChangesNotes(e.target.value)}
              placeholder="Describe the changes needed…"
              rows={4}
              style={{
                width: '100%',
                padding: '0.5rem',
                borderRadius: 5,
                border: '1px solid #ccc',
                fontSize: '0.85rem',
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
              aria-label="Request changes notes"
            />
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button
                onClick={() => { setShowRequestChangesForm(false); setRequestChangesNotes(''); }}
                style={{ padding: '0.5rem 1rem', borderRadius: 5, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: '0.9rem' }}
              >
                Cancel
              </button>
              <button
                onClick={handleRequestChanges}
                disabled={!requestChangesNotes.trim()}
                style={{
                  padding: '0.5rem 1rem',
                  borderRadius: 5,
                  border: 'none',
                  background: requestChangesNotes.trim() ? '#f97316' : '#ccc',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: requestChangesNotes.trim() ? 'pointer' : 'not-allowed',
                  fontSize: '0.9rem',
                }}
              >
                Send Request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 1100, margin: '0 auto' };

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

const backBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#00a89d',
  cursor: 'pointer',
  fontSize: '0.9rem',
  padding: '0 0 0.75rem',
  display: 'block',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: '1.25rem',
};

const splitLayoutStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 380px',
  gap: '1rem',
  alignItems: 'start',
};

const leftPanelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const rightPanelStyle: React.CSSProperties = {
  position: 'sticky',
  top: '1rem',
};

const sectionCardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '1rem',
};

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '1rem',
  fontWeight: 600,
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: '0.78rem',
  color: '#888',
  fontWeight: 600,
  textTransform: 'uppercase',
  padding: '0.4rem 0.5rem',
  borderBottom: '2px solid #eee',
};

const tdStyle: React.CSSProperties = {
  padding: '0.5rem',
  fontSize: '0.85rem',
  borderBottom: '1px solid #f0f0f0',
  verticalAlign: 'top',
};

const historyItemStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.4rem 0.6rem',
  background: '#f8f9fa',
  borderRadius: 6,
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  background: '#fff', borderRadius: 8, padding: '1.5rem',
  maxWidth: 450, width: '90%', boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
};