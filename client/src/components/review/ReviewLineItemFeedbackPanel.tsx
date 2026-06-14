import { useState } from 'react';
import type { QuoteLineItem } from 'shared';
import { addFeedback } from '../../api';

interface FeedbackItem {
  id: string;
  lineItemId: string;
  fieldName: string;
  comment: string;
  createdAt: string;
}

interface Props {
  lineItems: QuoteLineItem[];
  feedback: FeedbackItem[];
  reviewId: string;
  readOnly?: boolean;
}

export default function ReviewLineItemFeedbackPanel({ lineItems, feedback, reviewId, readOnly }: Props) {
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feedbackByLineItem = new Map<string, FeedbackItem[]>();
  for (const fb of feedback) {
    const list = feedbackByLineItem.get(fb.lineItemId) ?? [];
    list.push(fb);
    feedbackByLineItem.set(fb.lineItemId, list);
  }

  const handleAddComment = async (lineItemId: string) => {
    if (!commentText.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await addFeedback(reviewId, lineItemId, 'general', commentText.trim());
      setCommentText('');
      setExpandedItem(null);
      // The parent will re-fetch to show the new comment
    } catch (err) {
      setError((err as any).message ?? 'Failed to add comment.');
    } finally {
      setSaving(false);
    }
  };

  const panelStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    padding: '1rem',
  };

  const titleStyle: React.CSSProperties = {
    margin: '0 0 0.75rem',
    fontSize: '1rem',
    fontWeight: 600,
  };

  const itemStyle: React.CSSProperties = {
    borderBottom: '1px solid #f0f0f0',
    padding: '0.5rem 0',
  };

  const itemNameStyle: React.CSSProperties = {
    fontWeight: 600,
    fontSize: '0.9rem',
    marginBottom: '0.25rem',
  };

  const commentStyle: React.CSSProperties = {
    background: '#f8f9fa',
    borderRadius: 6,
    padding: '0.5rem 0.75rem',
    marginBottom: '0.35rem',
    fontSize: '0.85rem',
  };

  const fieldNameStyle: React.CSSProperties = {
    fontSize: '0.7rem',
    color: '#888',
    fontWeight: 600,
    textTransform: 'uppercase',
    marginRight: '0.5rem',
  };

  const timestampStyle: React.CSSProperties = {
    fontSize: '0.7rem',
    color: '#aaa',
    marginTop: '0.15rem',
    display: 'block',
  };

  return (
    <div style={panelStyle}>
      <h3 style={titleStyle}>Line Item Feedback</h3>

      {lineItems.length === 0 && (
        <p style={{ fontSize: '0.85rem', color: '#888' }}>No line items in this quote.</p>
      )}

      {lineItems.map((item) => {
        const itemFeedback = feedbackByLineItem.get(item.id) ?? [];
        const isExpanded = expandedItem === item.id;

        return (
          <div key={item.id} style={itemStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={itemNameStyle}>{item.productName}</span>
                {itemFeedback.length > 0 && (
                  <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#7c3aed', fontWeight: 600 }}>
                    ({itemFeedback.length})
                  </span>
                )}
              </div>
              {!readOnly && (
                <button
                  onClick={() => {
                    setExpandedItem(isExpanded ? null : item.id);
                    setCommentText('');
                    setError(null);
                  }}
                  style={{
                    background: 'none',
                    border: '1px solid #ccc',
                    borderRadius: 5,
                    padding: '0.25rem 0.6rem',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    color: '#555',
                  }}
                >
                  {isExpanded ? 'Cancel' : 'Add Feedback'}
                </button>
              )}
            </div>

            {/* Existing comments */}
            {itemFeedback.map((fb) => (
              <div key={fb.id} style={{ ...commentStyle, marginTop: '0.5rem' }}>
                <span style={fieldNameStyle}>{fb.fieldName}</span>
                <span>{fb.comment}</span>
                <span style={timestampStyle}>
                  {new Date(fb.createdAt).toLocaleString()}
                </span>
              </div>
            ))}

            {/* Expanded textarea for new comment */}
            {isExpanded && (
              <div style={{ marginTop: '0.5rem' }}>
                <textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Add your feedback comment…"
                  rows={2}
                  style={{
                    width: '100%',
                    padding: '0.4rem 0.6rem',
                    borderRadius: 5,
                    border: '1px solid #ccc',
                    fontSize: '0.85rem',
                    boxSizing: 'border-box',
                    resize: 'vertical',
                  }}
                  aria-label={`Feedback for ${item.productName}`}
                />
                {error && (
                  <p style={{ fontSize: '0.8rem', color: '#c00', margin: '0.25rem 0' }} role="alert">{error}</p>
                )}
                <div style={{ marginTop: '0.35rem', display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => handleAddComment(item.id)}
                    disabled={!commentText.trim() || saving}
                    style={{
                      padding: '0.35rem 0.85rem',
                      borderRadius: 5,
                      border: 'none',
                      background: !commentText.trim() || saving ? '#ccc' : '#00a89d',
                      color: '#fff',
                      fontWeight: 600,
                      fontSize: '0.8rem',
                      cursor: !commentText.trim() || saving ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {saving ? 'Adding…' : 'Add Comment'}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}