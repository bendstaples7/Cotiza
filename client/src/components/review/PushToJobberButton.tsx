import { useState } from 'react';

type PushState = 'idle' | 'loading' | 'success' | 'error';

interface Props {
  onPush: () => Promise<void>;
  onRequestChanges: () => Promise<void>;
  pushDisabled?: boolean;
  pushTooltip?: string;
  hasFeedback?: boolean;
}

export default function PushToJobberButton({ onPush, onRequestChanges, pushDisabled, pushTooltip, hasFeedback }: Props) {
  const [pushState, setPushState] = useState<PushState>('idle');
  const [changeState, setChangeState] = useState<'idle' | 'loading'>('idle');
  const [pushError, setPushError] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [showPushConfirm, setShowPushConfirm] = useState(false);
  const [showChangeConfirm, setShowChangeConfirm] = useState(false);

  const handlePush = async () => {
    setShowPushConfirm(false);
    setPushState('loading');
    setPushError(null);
    try {
      await onPush();
      setPushState('success');
    } catch (err) {
      setPushState('error');
      setPushError((err as any).message ?? 'Failed to push to Jobber.');
    }
  };

  const handleRequestChanges = async () => {
    setShowChangeConfirm(false);
    setChangeState('loading');
    setChangeError(null);
    try {
      await onRequestChanges();
      setChangeState('idle');
    } catch (err) {
      setChangeError((err as any).message ?? 'Failed to request changes.');
      setChangeState('idle');
    }
  };

  const buttonRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'center',
    flexWrap: 'wrap',
  };

  const primaryBtnStyle: React.CSSProperties = {
    padding: '0.65rem 1.5rem',
    borderRadius: 6,
    border: 'none',
    fontWeight: 600,
    fontSize: '0.95rem',
    cursor: pushDisabled || pushState === 'loading' ? 'not-allowed' : 'pointer',
    background: pushState === 'success' ? '#16a34a' : pushState === 'error' ? '#dc2626' : pushDisabled ? '#ccc' : '#00a89d',
    color: '#fff',
    opacity: pushState === 'loading' ? 0.7 : 1,
  };

  const secondaryBtnStyle: React.CSSProperties = {
    padding: '0.65rem 1.5rem',
    borderRadius: 6,
    border: '1px solid #f97316',
    background: '#fff',
    color: '#f97316',
    fontWeight: 600,
    fontSize: '0.95rem',
    cursor: changeState === 'loading' ? 'not-allowed' : 'pointer',
    opacity: changeState === 'loading' ? 0.7 : 1,
  };

  // Confirmation dialog overlay
  const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  };

  const dialogStyle: React.CSSProperties = {
    background: '#fff', borderRadius: 8, padding: '1.5rem',
    maxWidth: 400, width: '90%', boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
  };

  return (
    <div>
      <div style={buttonRowStyle}>
        {/* Primary: Push to Jobber */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => {
              if (pushDisabled || pushState === 'loading') return;
              if (pushState === 'success') return;
              setShowPushConfirm(true);
            }}
            disabled={pushDisabled || pushState === 'loading'}
            style={primaryBtnStyle}
            title={pushDisabled ? pushTooltip ?? '' : undefined}
          >
            {pushState === 'loading' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={smallSpinnerStyle} /> Pushing…
              </span>
            ) : pushState === 'success' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                ✅ Pushed to Jobber
              </span>
            ) : pushState === 'error' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                ⚠️ Retry Push
              </span>
            ) : (
              '🚀 Push to Jobber'
            )}
          </button>
        </div>

        {/* Secondary: Request Changes */}
        <button
          onClick={() => {
            if (changeState === 'loading') return;
            setShowChangeConfirm(true);
          }}
          disabled={changeState === 'loading'}
          style={secondaryBtnStyle}
        >
          {changeState === 'loading' ? 'Requesting…' : 'Request Changes'}
        </button>
      </div>

      {/* Push error */}
      {pushState === 'error' && pushError && (
        <div
          role="alert"
          style={{
            marginTop: '0.5rem',
            background: '#fdecea',
            color: '#611a15',
            padding: '0.5rem 0.75rem',
            borderRadius: 5,
            fontSize: '0.85rem',
          }}
        >
          {pushError}
        </div>
      )}

      {/* Change error */}
      {changeError && (
        <div
          role="alert"
          style={{
            marginTop: '0.5rem',
            background: '#fdecea',
            color: '#611a15',
            padding: '0.5rem 0.75rem',
            borderRadius: 5,
            fontSize: '0.85rem',
          }}
        >
          {changeError}
        </div>
      )}

      {/* Push confirmation */}
      {showPushConfirm && (
        <div style={overlayStyle} onClick={() => setShowPushConfirm(false)}>
          <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>Push to Jobber</h3>
            <p style={{ fontSize: '0.9rem', color: '#555', lineHeight: 1.5 }}>
              This will sync quote data to Jobber. Continue?
              {hasFeedback && (
                <span style={{ display: 'block', marginTop: '0.5rem', color: '#7c3aed', fontWeight: 600 }}>
                  Note: There is feedback on line items that will be pushed.
                </span>
              )}
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button
                onClick={() => setShowPushConfirm(false)}
                style={{ padding: '0.5rem 1rem', borderRadius: 5, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: '0.9rem' }}
              >
                Cancel
              </button>
              <button
                onClick={handlePush}
                style={{ padding: '0.5rem 1rem', borderRadius: 5, border: 'none', background: '#00a89d', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem' }}
              >
                Confirm Push
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Request Changes confirmation */}
      {showChangeConfirm && (
        <div style={overlayStyle} onClick={() => setShowChangeConfirm(false)}>
          <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>Request Changes</h3>
            <p style={{ fontSize: '0.9rem', color: '#555', lineHeight: 1.5 }}>
              This will send the quote back for edits. The preparer will be able to modify the quote and re-submit for review. Continue?
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button
                onClick={() => setShowChangeConfirm(false)}
                style={{ padding: '0.5rem 1rem', borderRadius: 5, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: '0.9rem' }}
              >
                Cancel
              </button>
              <button
                onClick={handleRequestChanges}
                style={{ padding: '0.5rem 1rem', borderRadius: 5, border: 'none', background: '#f97316', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem' }}
              >
                Request Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const smallSpinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 14,
  height: 14,
  border: '2px solid rgba(255,255,255,0.3)',
  borderTopColor: '#fff',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};