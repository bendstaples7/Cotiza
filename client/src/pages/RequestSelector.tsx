import { useState, useEffect, useRef, useCallback } from 'react';
import type { JobberCustomerRequest } from 'shared';
import { fetchJobberRequests } from '../api';

const POLL_INTERVAL_MS = 60_000; // Poll every 60 seconds

interface RequestSelectorProps {
  onSelect: (request: JobberCustomerRequest) => void;
  onClear: () => void;
  selectedRequestId: string | null;
  hasFormData?: boolean;
}

export default function RequestSelector({ onSelect, onClear, selectedRequestId, hasFormData }: RequestSelectorProps) {
  const [requests, setRequests] = useState<JobberCustomerRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRequests = useCallback(async (opts?: { fresh?: boolean; silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const data = await fetchJobberRequests({ fresh: opts?.fresh });
      setRequests(data.requests);
    } catch {
      if (!opts?.silent) {
        setError('Could not load Jobber requests. You can enter text manually below.');
      }
    } finally {
      if (!opts?.silent) setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  // Poll every 60 seconds (silent background refresh)
  useEffect(() => {
    pollRef.current = setInterval(() => {
      loadRequests({ fresh: true, silent: true });
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadRequests]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadRequests({ fresh: true });
  };

  const selectedRequest = requests.find((r) => r.id === selectedRequestId);

  if (loading) {
    return (
      <div style={wrapperStyle}>
        <span style={headingStyle}>Jobber Requests</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '1rem 0' }}>
          <span style={spinnerStyle} />
          <span style={{ fontSize: '0.85rem', color: '#666' }}>Loading requests…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={wrapperStyle}>
        <span style={headingStyle}>Jobber Requests</span>
        <div style={inlineMessageStyle}>{error}</div>
      </div>
    );
  }

  if (requests.length === 0) {
    return (
      <div style={wrapperStyle}>
        <span style={headingStyle}>Jobber Requests</span>
        <div style={inlineMessageStyle}>No customer requests found. You can enter text manually below.</div>
      </div>
    );
  }

  // Show read-only detail view when a request is selected
  if (selectedRequest) {
    const hasDescription = !!selectedRequest.description?.trim();
    const hasNotes = selectedRequest.structuredNotes.length > 0;
    const hasImages = selectedRequest.imageUrls.length > 0;
    const hasNoContent = !hasDescription && !hasNotes && !hasImages && !hasFormData;

    return (
      <div style={wrapperStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span style={headingStyle}>Selected Request</span>
          <button onClick={onClear} style={clearBtnStyle} type="button">
            Change request
          </button>
        </div>
        <div style={detailCardStyle}>
          <div style={{ marginBottom: '0.5rem' }}>
            <span style={{ fontWeight: 600, fontSize: '1rem' }}>{selectedRequest.title}</span>
          </div>
          <div style={{ fontSize: '0.85rem', color: '#555', marginBottom: '0.75rem' }}>
            {selectedRequest.clientName} · {formatDate(selectedRequest.createdAt)}
          </div>

          {/* Description — only shown when there are no structured notes (avoids duplication
              since description is often built from the same note messages) */}
          {hasDescription && !hasNotes && (
            <div style={{ marginBottom: '0.75rem' }}>
              <span style={sectionLabelStyle}>Description</span>
              <div style={noteStyle}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{selectedRequest.description}</div>
              </div>
            </div>
          )}

          {/* Notes — single canonical place for note content */}
          {hasNotes && (
            <div style={{ marginBottom: '0.75rem' }}>
              <span style={sectionLabelStyle}>Notes</span>
              {selectedRequest.structuredNotes.map((note, i) => (
                <div key={i} style={noteStyle}>
                  <span style={noteLabelStyle}>
                    {note.createdBy === 'team' ? '👤 Team Note' : note.createdBy === 'client' ? '📩 Client' : '🤖 System'}
                  </span>
                  {note.message}
                </div>
              ))}
            </div>
          )}

          {/* Images */}
          {hasImages && (
            <div>
              <span style={sectionLabelStyle}>Attached Images</span>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                {selectedRequest.imageUrls.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={url}
                      alt={`Attachment ${i + 1}`}
                      style={attachmentImgStyle}
                    />
                  </a>
                ))}
              </div>
            </div>
          )}

          {hasNoContent && (
            <div style={{ fontSize: '0.85rem', color: '#6d4c00', background: '#fff3e0', padding: '0.5rem 0.75rem', borderRadius: 4 }}>
              No details available for this request. Open it in Jobber and paste the details below.
            </div>
          )}

          {/* Link to Jobber */}
          {selectedRequest.jobberWebUri && (
            <div style={{ marginTop: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid #e0e0e0' }}>
              <a
                href={selectedRequest.jobberWebUri}
                target="_blank"
                rel="noopener noreferrer"
                style={jobberLinkStyle}
              >
                Open in Jobber ↗
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Show request list for selection
  return (
    <div style={wrapperStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span style={headingStyle}>Jobber Requests</span>
        <button onClick={handleRefresh} disabled={refreshing} style={refreshBtnStyle} type="button">
          {refreshing ? '↻ Refreshing…' : '↻ Refresh'}
        </button>
      </div>
      <div style={listStyle}>
        {requests.map((req) => (
          <button
            key={req.id}
            onClick={() => onSelect(req)}
            style={itemStyle}
            type="button"
          >
            <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>{req.title}</span>
            <span style={{ fontSize: '0.8rem', color: '#666' }}>
              {req.clientName} · {formatDate(req.createdAt)}
              {req.imageUrls.length > 0 && ` · 📷 ${req.imageUrls.length}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Styles ──

const wrapperStyle: React.CSSProperties = { marginBottom: '1.25rem' };
const headingStyle: React.CSSProperties = { fontWeight: 500, fontSize: '0.9rem' };

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  maxHeight: 220,
  overflowY: 'auto',
};

const itemStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.15rem',
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  border: '1px solid #e0e0e0',
  borderRadius: 6,
  cursor: 'pointer',
  background: '#fff',
  transition: 'border-color 0.15s, background 0.15s',
  fontFamily: 'inherit',
};

const clearBtnStyle: React.CSSProperties = {
  padding: '0.25rem 0.5rem',
  border: '1px solid #00a89d',
  background: 'transparent',
  color: '#00a89d',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.8rem',
};

const refreshBtnStyle: React.CSSProperties = {
  padding: '0.2rem 0.5rem',
  border: '1px solid #ccc',
  background: 'transparent',
  color: '#555',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.75rem',
  fontFamily: 'inherit',
};

const detailCardStyle: React.CSSProperties = {
  border: '1px solid #00a89d',
  borderRadius: 8,
  padding: '1rem',
  background: '#f8fbff',
};

const noteStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e8e8e8',
  borderRadius: 4,
  padding: '0.5rem 0.75rem',
  marginTop: '0.4rem',
  fontSize: '0.85rem',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
};

const sectionLabelStyle: React.CSSProperties = {
  fontWeight: 500,
  fontSize: '0.8rem',
  color: '#888',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.03em',
};

const noteLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.7rem',
  fontWeight: 600,
  color: '#888',
  marginBottom: '0.2rem',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.03em',
};

const jobberLinkStyle: React.CSSProperties = {
  color: '#00a89d',
  fontSize: '0.85rem',
  fontWeight: 500,
  textDecoration: 'none',
};

const attachmentImgStyle: React.CSSProperties = {
  width: 100,
  height: 100,
  objectFit: 'cover',
  borderRadius: 6,
  border: '1px solid #e0e0e0',
};

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 14,
  height: 14,
  border: '2px solid #ccc',
  borderTopColor: '#00a89d',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};

const inlineMessageStyle: React.CSSProperties = {
  background: '#fff3e0',
  color: '#6d4c00',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  marginTop: '0.25rem',
  fontSize: '0.85rem',
};
