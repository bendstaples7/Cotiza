import React, { useState, useEffect, useRef } from 'react';
import type { ResolveRequestQuoteResult } from '../api';
import { importJobberQuote } from '../api';

export interface RequestJobberQuoteModalProps {
  resolution: ResolveRequestQuoteResult;
  customerName: string;
  onClose: () => void;
  onOpenCotiza: (draftId: string) => void;
  onGenerateNew: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function statusBadgeStyle(status: string): React.CSSProperties {
  const normalized = status.toLowerCase();
  return {
    padding: '0.1rem 0.35rem',
    borderRadius: 4,
    fontSize: '0.7rem',
    fontWeight: 500,
    background: normalized === 'draft' ? '#e3f2fd' : normalized === 'sent' ? '#e8f5e9' : '#f5f5f5',
    color: normalized === 'draft' ? '#1565c0' : normalized === 'sent' ? '#2e7d32' : '#666',
    textTransform: 'capitalize',
  };
}

export default function RequestJobberQuoteModal({
  resolution,
  customerName,
  onClose,
  onOpenCotiza,
  onGenerateNew,
}: RequestJobberQuoteModalProps) {
  const unimported = resolution.jobberQuotes.filter((q) => !q.importedDraftId);
  const displayQuotes = unimported.length > 0 ? unimported : resolution.jobberQuotes;
  const primaryQuote = displayQuotes[0];
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const cancelledRef = useRef(false);
  const importingRef = useRef(importing);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  importingRef.current = importing;

  useEffect(() => {
    mountedRef.current = true;
    cancelledRef.current = false;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement;
    dialogRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !importingRef.current) {
        cancelledRef.current = true;
        onClose();
        return;
      }

      if (e.key !== 'Tab' || !dialogRef.current) return;

      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || active === dialogRef.current) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleImport = async () => {
    if (!primaryQuote || primaryQuote.importedDraftId) return;
    cancelledRef.current = false;
    setImporting(true);
    setImportError(null);
    try {
      const result = await importJobberQuote(primaryQuote.id);
      if (mountedRef.current && !cancelledRef.current) {
        onOpenCotiza(result.draft.id);
      }
    } catch (err) {
      if (mountedRef.current && !cancelledRef.current) {
        setImportError((err as { message?: string }).message ?? 'Failed to import Jobber quote.');
      }
    } finally {
      if (mountedRef.current) {
        setImporting(false);
      }
    }
  };

  const handleDismiss = () => {
    if (importing) return;
    cancelledRef.current = true;
    onClose();
  };

  const cotizaDraftId = resolution.cotizaDraft?.id;

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-labelledby="jobber-quote-modal-title">
      <div ref={dialogRef} tabIndex={-1} style={modalStyle}>
        <h2 id="jobber-quote-modal-title" style={titleStyle}>
          Jobber quote found
        </h2>
        <p style={subtitleStyle}>
          {customerName} has an in-progress quote in Jobber. Import it first to avoid duplicates.
        </p>

        {resolution.jobberLookupFailed && (
          <div style={warnStyle}>
            Could not reach Jobber — showing local drafts only.
          </div>
        )}

        {importError && (
          <div role="alert" style={errorStyle}>{importError}</div>
        )}

        {displayQuotes.length > 0 && (
          <div style={listStyle}>
            {displayQuotes.map((quote) => (
              <div key={quote.id} style={quoteCardStyle}>
                <div style={quoteHeaderStyle}>
                  <span style={quoteNumberStyle}>Quote #{quote.quoteNumber}</span>
                  <span style={statusBadgeStyle(quote.quoteStatus)}>{quote.quoteStatus.replace(/_/g, ' ')}</span>
                </div>
                {quote.title && <p style={quoteTitleStyle}>{quote.title}</p>}
                {quote.jobberWebUri && (
                  <a
                    href={quote.jobberWebUri}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={jobberLinkStyle}
                  >
                    View in Jobber →
                  </a>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={primaryActionsStyle}>
          {primaryQuote && !primaryQuote.importedDraftId && (
            <button
              type="button"
              style={primaryBtnStyle}
              disabled={importing}
              onClick={() => void handleImport()}
            >
              {importing ? 'Importing…' : 'Import Jobber quote to Cotiza'}
            </button>
          )}
          <button type="button" style={secondaryBtnStyle} onClick={onGenerateNew} disabled={importing}>
            Generate new Cotiza quote
          </button>
        </div>

        <div style={footerStyle}>
          {cotizaDraftId && (
            <button type="button" style={tertiaryBtnStyle} onClick={() => onOpenCotiza(cotizaDraftId)}>
              Open existing Cotiza draft (D-{resolution.cotizaDraft!.draftNumber})
            </button>
          )}
          <button type="button" style={ghostBtnStyle} onClick={handleDismiss} disabled={importing}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1100,
  padding: '1rem',
};

const modalStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 10,
  padding: '1.25rem',
  maxWidth: 480,
  width: '100%',
  maxHeight: '90vh',
  overflowY: 'auto',
  boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
};

const titleStyle: React.CSSProperties = {
  margin: '0 0 0.35rem',
  fontSize: '1.15rem',
  color: '#061216',
};

const subtitleStyle: React.CSSProperties = {
  margin: '0 0 1rem',
  fontSize: '0.9rem',
  color: '#555',
  lineHeight: 1.45,
};

const warnStyle: React.CSSProperties = {
  background: '#fff3e0',
  color: '#6d4c00',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  fontSize: '0.85rem',
  marginBottom: '0.75rem',
};

const errorStyle: React.CSSProperties = {
  background: '#fdecea',
  color: '#611a15',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  fontSize: '0.85rem',
  marginBottom: '0.75rem',
};

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  marginBottom: '1rem',
};

const quoteCardStyle: React.CSSProperties = {
  border: '1px solid #e0e0e0',
  borderRadius: 6,
  padding: '0.75rem',
  background: '#fafafa',
};

const quoteHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  marginBottom: '0.35rem',
};

const quoteNumberStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '0.9rem',
  color: '#00a89d',
};

const quoteTitleStyle: React.CSSProperties = {
  margin: '0 0 0.35rem',
  fontSize: '0.85rem',
  color: '#444',
};

const jobberLinkStyle: React.CSSProperties = {
  color: '#00a89d',
  fontSize: '0.9rem',
  fontWeight: 600,
  textDecoration: 'none',
  display: 'inline-block',
};

const primaryActionsStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  marginBottom: '0.75rem',
};

const primaryBtnStyle: React.CSSProperties = {
  flex: '1 1 160px',
  padding: '0.55rem 0.85rem',
  border: '1px solid #00a89d',
  background: '#00a89d',
  color: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.9rem',
  fontWeight: 600,
  fontFamily: 'inherit',
};

const secondaryBtnStyle: React.CSSProperties = {
  flex: '1 1 160px',
  padding: '0.55rem 0.85rem',
  border: '1px solid #d0d0d0',
  background: '#fff',
  color: '#333',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.9rem',
  fontWeight: 500,
  fontFamily: 'inherit',
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
  borderTop: '1px solid #eee',
  paddingTop: '0.75rem',
};

const tertiaryBtnStyle: React.CSSProperties = {
  padding: '0.35rem 0',
  border: 'none',
  background: 'transparent',
  color: '#555',
  cursor: 'pointer',
  fontSize: '0.85rem',
  fontFamily: 'inherit',
  textAlign: 'left',
};

const ghostBtnStyle: React.CSSProperties = {
  padding: '0.35rem 0',
  border: 'none',
  background: 'transparent',
  color: '#888',
  cursor: 'pointer',
  fontSize: '0.85rem',
  fontFamily: 'inherit',
  textAlign: 'left',
};
