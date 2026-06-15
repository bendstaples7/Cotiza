import { useState, useEffect, useCallback } from 'react';
import type { ImportableQuote } from '../api';
import { fetchImportableQuotes, importJobberQuote } from '../api';

interface JobberQuoteImportSectionProps {
  onImportSuccess: (draftId: string) => void;
}

/** Format a deathclock age from an ISO timestamp. */
function computeAgeSeconds(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
}

function formatAge(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m`;
}

function formatCurrency(amount: number): string {
  return '$' + amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getQuoteTotal(quote: ImportableQuote): number {
  return (quote.lineItems || []).reduce((sum, item) => sum + item.quantity * item.unitPrice.amount, 0);
}

function getClientName(quote: ImportableQuote): string {
  if (!quote.client) return 'Unknown Client';
  const { firstName, lastName, companyName } = quote.client;
  return companyName || [firstName, lastName].filter(Boolean).join(' ') || 'Unknown Client';
}

export default function JobberQuoteImportSection({ onImportSuccess }: JobberQuoteImportSectionProps) {
  const [quotes, setQuotes] = useState<ImportableQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);

  const loadQuotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchImportableQuotes();
      setQuotes(data.quotes);
      if (!data.available) {
        setError('Jobber API is not available. Check credentials and connectivity.');
      }
    } catch {
      setError('Could not load importable Jobber quotes.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (expanded) {
      loadQuotes();
    }
  }, [expanded, loadQuotes]);

  const handleImport = async (quoteId: string) => {
    setImportingIds(prev => new Set(prev).add(quoteId));
    try {
      const result = await importJobberQuote(quoteId);
      if (result.warnings.length > 0) {
        console.warn('[JobberQuoteImport] Warnings:', result.warnings);
      }
      onImportSuccess(result.draft.id);
    } catch (err) {
      // Error displayed via toast from handleResponseWithToast
      console.error('[JobberQuoteImport] Failed:', err);
    } finally {
      setImportingIds(prev => {
        const next = new Set(prev);
        next.delete(quoteId);
        return next;
      });
    }
  };

  return (
    <div style={wrapperStyle}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={toggleBtnStyle}
        type="button"
      >
        <span style={toggleIconStyle}>{expanded ? '▼' : '▶'}</span>
        <span style={headingStyle}>Import from Jobber</span>
        {!expanded && quotes.length > 0 && (
          <span style={badgeStyle}>{quotes.length} available</span>
        )}
      </button>

      {expanded && (
        <div style={contentStyle}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '1rem 0' }}>
              <span style={spinnerStyle} />
              <span style={{ fontSize: '0.85rem', color: '#666' }}>Loading importable quotes…</span>
            </div>
          )}

          {error && !loading && (
            <div style={errorStyle}>{error}</div>
          )}

          {!loading && !error && quotes.length === 0 && (
            <div style={emptyStyle}>No in-progress quotes found in Jobber to import.</div>
          )}

          {!loading && !error && quotes.length > 0 && (
            <div style={listStyle}>
              {quotes.map((quote) => {
                const total = getQuoteTotal(quote);
                const lineItemCount = quote.lineItems?.length || 0;
                const ageSeconds = computeAgeSeconds(quote.createdAt);
                const isImporting = importingIds.has(quote.id);

                return (
                  <div key={quote.id} style={quoteCardStyle}>
                    <div style={quoteCardHeaderStyle}>
                      <div style={quoteCardTitleStyle}>
                        <span style={quoteNumberStyle}>#{quote.quoteNumber}</span>
                        <span style={clientNameStyle}>{getClientName(quote)}</span>
                      </div>
                      <div style={metaRowStyle}>
                        <span style={statusBadgeStyle(quote.quoteStatus)}>
                          {quote.quoteStatus}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: '#888' }}>
                          {formatAge(ageSeconds)} old
                        </span>
                      </div>
                    </div>

                    {quote.title && (
                      <div style={titleRowStyle}>{quote.title}</div>
                    )}

                    <div style={detailsRowStyle}>
                      <span>{formatCurrency(total)}</span>
                      <span>&middot;</span>
                      <span>{lineItemCount} line item{lineItemCount !== 1 ? 's' : ''}</span>
                    </div>

                    <button
                      onClick={() => handleImport(quote.id)}
                      disabled={isImporting}
                      style={{
                        ...importBtnStyle,
                        opacity: isImporting ? 0.6 : 1,
                      }}
                      type="button"
                    >
                      {isImporting ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                          <span style={smallSpinnerStyle} />
                          Importing…
                        </span>
                      ) : (
                        'Import as Draft'
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Styles ──

const wrapperStyle: React.CSSProperties = {
  marginBottom: '1.25rem',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  overflow: 'hidden',
};

const toggleBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  width: '100%',
  padding: '0.65rem 0.75rem',
  border: 'none',
  background: '#f5f5f5',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '0.9rem',
  textAlign: 'left',
};

const toggleIconStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  color: '#888',
  width: 14,
};

const headingStyle: React.CSSProperties = {
  fontWeight: 500,
  color: '#333',
};

const badgeStyle: React.CSSProperties = {
  marginLeft: '0.5rem',
  padding: '0.1rem 0.4rem',
  background: '#00a89d',
  color: '#fff',
  borderRadius: 10,
  fontSize: '0.7rem',
  fontWeight: 600,
};

const contentStyle: React.CSSProperties = {
  padding: '0.75rem',
  borderTop: '1px solid #e0e0e0',
};

const errorStyle: React.CSSProperties = {
  background: '#fff3e0',
  color: '#6d4c00',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  fontSize: '0.85rem',
};

const emptyStyle: React.CSSProperties = {
  color: '#888',
  fontSize: '0.85rem',
  padding: '0.5rem 0',
};

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  maxHeight: 320,
  overflowY: 'auto',
};

const quoteCardStyle: React.CSSProperties = {
  border: '1px solid #e0e0e0',
  borderRadius: 6,
  padding: '0.65rem',
  background: '#fff',
};

const quoteCardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: '0.25rem',
};

const quoteCardTitleStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.1rem',
};

const quoteNumberStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '0.85rem',
  color: '#00a89d',
};

const clientNameStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: '#555',
};

const metaRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};

const statusBadgeStyle = (status: string): React.CSSProperties => ({
  padding: '0.1rem 0.35rem',
  borderRadius: 4,
  fontSize: '0.7rem',
  fontWeight: 500,
  background: status === 'draft' ? '#e3f2fd' : status === 'sent' ? '#e8f5e9' : '#f5f5f5',
  color: status === 'draft' ? '#1565c0' : status === 'sent' ? '#2e7d32' : '#666',
  textTransform: 'capitalize' as const,
});

const titleRowStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: '#444',
  marginBottom: '0.35rem',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const detailsRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  fontSize: '0.8rem',
  color: '#666',
  marginBottom: '0.5rem',
};

const importBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.35rem 0',
  border: '1px solid #00a89d',
  background: '#00a89d',
  color: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: 500,
  fontFamily: 'inherit',
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

const smallSpinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  border: '2px solid rgba(255,255,255,0.3)',
  borderTopColor: '#fff',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};