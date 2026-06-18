import type { QuoteLineItem } from 'shared';

export interface ReviewFeedbackItem {
  id: string;
  lineItemId: string;
  fieldName: string;
  comment: string;
  createdAt: string;
}

interface Props {
  lineItems: QuoteLineItem[];
  feedback: ReviewFeedbackItem[];
  reviewId: string;
  readOnly?: boolean;
  onAddFeedback?: (lineItemId: string) => void;
}

export default function ReviewLineItemFeedbackPanel({ lineItems, feedback, readOnly, onAddFeedback }: Props) {
  if (lineItems.length === 0) {
    return (
      <div style={{ padding: '1rem', color: '#888', fontSize: '0.9rem' }}>
        No line items in this quote.
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600 }}>
        Line Item Feedback
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {lineItems.map((item) => {
          const itemFeedback = feedback.filter((f) => f.lineItemId === item.id);
          return (
            <div
              key={item.id}
              style={{
                border: '1px solid #e0e0e0',
                borderRadius: 6,
                padding: '0.75rem',
                background: '#fff',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: itemFeedback.length > 0 ? '0.5rem' : 0 }}>
                <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{item.productName}</span>
                {itemFeedback.length > 0 && (
                  <span style={{
                    fontSize: '0.75rem',
                    color: '#7c3aed',
                    fontWeight: 600,
                    background: '#ede9fe',
                    padding: '0.1rem 0.4rem',
                    borderRadius: 10,
                  }}>
                    ({itemFeedback.length})
                  </span>
                )}
              </div>

              {itemFeedback.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {itemFeedback.map((fb) => (
                    <div key={fb.id} style={{ fontSize: '0.85rem', color: '#444', paddingLeft: '0.5rem', borderLeft: '2px solid #e0e0e0' }}>
                      <span style={{ color: '#888', fontSize: '0.75rem', marginRight: '0.4rem' }}>
                        {fb.fieldName}
                      </span>
                      {fb.comment}
                    </div>
                  ))}
                </div>
              )}

              {!readOnly && (
                <button
                  onClick={() => onAddFeedback?.(item.id)}
                  style={{
                    marginTop: '0.5rem',
                    background: 'none',
                    border: '1px dashed #aaa',
                    borderRadius: 4,
                    padding: '0.25rem 0.6rem',
                    fontSize: '0.8rem',
                    color: '#555',
                    cursor: 'pointer',
                  }}
                >
                  Add Feedback
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
