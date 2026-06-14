import React from 'react';

type ReviewStatus = 'pending_review' | 'changes_requested' | 'push_to_jobber' | 'none' | null;

const BADGE_STYLES: Record<string, React.CSSProperties> = {
  pending_review: {
    background: '#ede9fe',
    color: '#7c3aed',
    border: '1px solid #c4b5fd',
  },
  changes_requested: {
    background: '#fff7ed',
    color: '#ea580c',
    border: '1px solid #fdba74',
  },
  push_to_jobber: {
    background: '#f0fdf4',
    color: '#16a34a',
    border: '1px solid #bbf7d0',
  },
};

const LABELS: Record<string, string> = {
  pending_review: 'Pending Review',
  changes_requested: 'Changes Requested',
  push_to_jobber: 'Pushed to Jobber',
};

export default function ReviewBadge({ status }: { status: ReviewStatus }) {
  if (!status || status === 'none') return null;

  const style = BADGE_STYLES[status] ?? BADGE_STYLES.pending_review;
  const label = LABELS[status] ?? status;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: '0.15rem 0.55rem',
        borderRadius: 999,
        fontSize: '0.75rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {label}
    </span>
  );
}