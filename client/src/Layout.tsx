import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useEffect, useRef, useState } from 'react';
import { API_BASE, getPendingReviewCount, triggerCookieRefresh } from './api';

const quotesNavItems = [
  { to: '/quotes/requests', label: 'Requests' },
  { to: '/quotes', label: 'Quotes' },
  { to: '/quotes/reviews', label: 'Pending Reviews' },
  { to: '/quotes/rules', label: 'Rules & Product Ordering' },
  { to: '/quotes/catalog', label: 'Catalog & Templates' },
];

const socialNavItems = [
  { to: '/social/dashboard', label: 'Social Media Dashboard' },
  { to: '/social/posts/quick', label: 'Quick Post' },
  { to: '/social/media', label: 'Media Library' },
  { to: '/social/settings', label: 'Settings' },
  { to: '/social/activity-log', label: 'Activity Log' },
];

function SystemsCheckOverlay({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: '#f5f5f5',
    }}>
      <div style={{
        background: '#fff', borderRadius: 8, padding: '2.5rem',
        maxWidth: 480, width: '100%', textAlign: 'center',
        boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
      }}>
        {children}
      </div>
    </div>
  );
}

function InstagramBanner({ instagram, onSkip, onSettings }: {
  instagram: { status: 'expired' | 'not_connected'; accountName?: string };
  onSkip: () => void;
  onSettings: () => void;
}) {
  const message = instagram.status === 'expired'
    ? `Your Instagram connection${instagram.accountName ? ` (${instagram.accountName})` : ''} has expired.`
    : 'Instagram is not connected.';

  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '1rem', padding: '0.75rem 1.25rem',
      background: '#fff3cd', borderBottom: '1px solid #ffc107',
      color: '#856404', fontSize: '0.9rem',
    }}>
      <span>{message} Connect Instagram in Settings for full functionality.</span>
      <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
        <button
          onClick={onSettings}
          style={{
            background: '#ffc107', color: '#856404', border: 'none',
            padding: '0.35rem 0.75rem', borderRadius: 4, cursor: 'pointer',
            fontWeight: 600, fontSize: '0.85rem',
          }}
        >
          Settings
        </button>
        <button
          onClick={onSkip}
          style={{
            background: 'transparent', color: '#856404', border: '1px solid #c9a800',
            padding: '0.35rem 0.75rem', borderRadius: 4, cursor: 'pointer',
            fontSize: '0.85rem',
          }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

/**
 * CRITICAL — BLOCKING GATE: This overlay blocks the user until Jobber session
 * cookies are refreshed. The app is completely unusable without them.
 * Do NOT make this skippable or non-blocking.
 */
function JobberSessionOverlay({ recheckSystems, recheckSystemsSilent }: {
  recheckSystems: () => Promise<void>;
  recheckSystemsSilent: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [pollCount, setPollCount] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  // Clean up the polling interval when the overlay unmounts (i.e. cookies became valid)
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  const stopPolling = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setMessage('Triggering cookie refresh…');
    try {
      const result = await triggerCookieRefresh();
      if (result.triggered) {
        setMessage('Refresh started. Waiting for completion (~60 seconds)…');
        setPollCount(0);
        pollCountRef.current = 0;
        // Clear any previous polling interval before starting a new one
        stopPolling();
        // Start polling — the workflow takes ~30-60 seconds
        intervalRef.current = setInterval(async () => {
          pollCountRef.current += 1;
          setPollCount(pollCountRef.current);

          if (pollCountRef.current >= 12) { // 12 * 10s = 2 minutes max
            stopPolling();
            setMessage('Refresh is taking longer than expected. Click Re-check to try again.');
            setRefreshing(false);
            return;
          }

          try {
            await recheckSystemsSilent();
            // If cookies are now valid, systemsStatus transitions to 'ready'
            // without flashing the 'checking' spinner. The overlay unmounts
            // and the useEffect cleanup above clears this interval.
          } catch {
            // Keep polling
          }
        }, 10000);
      } else {
        setMessage(result.error || 'Failed to trigger refresh.');
        setRefreshing(false);
      }
    } catch {
      setMessage('Failed to trigger refresh. Try the manual option below.');
      setRefreshing(false);
    }
  };

  return (
    <SystemsCheckOverlay>
      <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>🍪</div>
      <h2 style={{ margin: '0 0 0.75rem', color: '#333' }}>Refresh Jobber Session</h2>
      <p style={{ color: '#666', marginBottom: '1rem', lineHeight: 1.5 }}>
        Jobber session cookies are expired or missing. These are required to fetch
        customer request form submissions.
      </p>

      {message && (
        <p style={{ color: refreshing ? '#00a89d' : '#666', fontSize: '0.9rem', marginBottom: '1rem' }}>
          {refreshing && (
            <span style={{
              display: 'inline-block', width: 14, height: 14,
              border: '2px solid #ccc', borderTopColor: '#00a89d',
              borderRadius: '50%', animation: 'spin 0.6s linear infinite',
              marginRight: '0.5rem', verticalAlign: 'middle',
            }} />
          )}
          {message}
        </p>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          style={{
            background: refreshing ? '#ccc' : '#00a89d', color: '#fff', border: 'none',
            padding: '0.65rem 1.5rem', borderRadius: 6, cursor: refreshing ? 'default' : 'pointer',
            fontWeight: 600, fontSize: '0.95rem',
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh Cookies'}
        </button>
        <button
          onClick={recheckSystems}
          disabled={refreshing}
          style={{
            background: 'transparent', color: '#666', border: '1px solid #ccc',
            padding: '0.65rem 1.5rem', borderRadius: 6, cursor: 'pointer',
            fontWeight: 500, fontSize: '0.95rem',
          }}
        >
          Re-check
        </button>
      </div>

      <details style={{ marginTop: '1.5rem', textAlign: 'left' }}>
        <summary style={{ cursor: 'pointer', color: '#999', fontSize: '0.8rem' }}>
          Manual fallback (if automated refresh fails)
        </summary>
        <p style={{ color: '#666', fontSize: '0.85rem', marginTop: '0.5rem', lineHeight: 1.5 }}>
          Open{' '}
          <a href={`${API_BASE}/api/jobber-auth/set-cookies`} target="_blank" rel="noopener noreferrer" style={{ color: '#00a89d' }}>
            the cookie paste page
          </a>
          , follow the instructions, then click Re-check above.
        </p>
      </details>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </SystemsCheckOverlay>
  );
}

export default function Layout() {
  const { user, logout, systemsStatus, recheckSystems, recheckSystemsSilent, skipInstagram, skipJobberSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [pendingReviewCount, setPendingReviewCount] = useState(0);

  // Fetch pending review count for nav badge
  useEffect(() => {
    const fetchCount = async () => {
      try {
        const count = await getPendingReviewCount();
        setPendingReviewCount(count);
      } catch {
        // Non-critical — badge will show 0
      }
    };
    fetchCount();
    // Refresh count every 30 seconds
    const interval = setInterval(fetchCount, 30000);
    return () => clearInterval(interval);
  }, []);

  // Systems check states — render before the normal shell
  if (systemsStatus.state === 'checking') {
    return (
      <SystemsCheckOverlay>
        <div
          aria-label="Verifying connections"
          style={{
            width: 40, height: 40, border: '4px solid #e0e0e0',
            borderTop: '4px solid #00a89d', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite', margin: '0 auto 1rem',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <p style={{ color: '#555', margin: 0 }}>Verifying external connections…</p>
      </SystemsCheckOverlay>
    );
  }

  if (systemsStatus.state === 'jobber_unavailable') {
    return (
      <SystemsCheckOverlay>
        <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>🔗</div>
        <h2 style={{ margin: '0 0 0.75rem', color: '#333' }}>Connect Jobber</h2>
        <p style={{ color: '#666', marginBottom: '1.5rem', lineHeight: 1.5 }}>
          Jobber is required for quote generation and customer request management.
          Connect your Jobber account to continue.
        </p>
        <a
          href={`${API_BASE}/api/jobber-auth/authorize`}
          style={{
            display: 'inline-block', background: '#00a89d', color: '#fff',
            padding: '0.65rem 1.5rem', borderRadius: 6, textDecoration: 'none',
            fontWeight: 600, fontSize: '0.95rem',
          }}
        >
          Connect Jobber
        </a>
      </SystemsCheckOverlay>
    );
  }

  /*
   * CRITICAL — BLOCKING GATE: Jobber session cookies are REQUIRED for the app to function.
   * Without valid cookies, the app cannot fetch customer request form submissions
   * (requestDetails.form) from Jobber's internal API. The public API does NOT expose
   * this data. This MUST remain a blocking overlay — do NOT change to a non-blocking
   * banner or make it skippable. The app is completely unusable without working cookies.
   * See .kiro/steering/product.md "Jobber API Limitations" for full context.
   */
  if (systemsStatus.state === 'jobber_session_expired') {
    return <JobberSessionOverlay recheckSystems={recheckSystems} recheckSystemsSilent={recheckSystemsSilent} />;
  }

  if (systemsStatus.state === 'error') {
    return (
      <SystemsCheckOverlay>
        <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>⚠️</div>
        <h2 style={{ margin: '0 0 0.75rem', color: '#333' }}>Connection Error</h2>
        <p style={{ color: '#666', marginBottom: '1.5rem', lineHeight: 1.5 }}>
          {systemsStatus.message}
        </p>
        <button
          onClick={recheckSystems}
          style={{
            background: '#00a89d', color: '#fff', border: 'none',
            padding: '0.65rem 1.5rem', borderRadius: 6, cursor: 'pointer',
            fontWeight: 600, fontSize: '0.95rem',
          }}
        >
          Retry
        </button>
      </SystemsCheckOverlay>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* Instagram warning banner — shown above everything when instagram_issue */}
      {systemsStatus.state === 'instagram_issue' && (
        <InstagramBanner
          instagram={systemsStatus.instagram}
          onSkip={skipInstagram}
          onSettings={() => navigate('/social/settings')}
        />
      )}

      {/* Sidebar + content area */}
      <div style={{ display: 'flex', flex: 1 }}>
        <nav style={{ width: 220, background: '#0a1e24', color: '#fff', padding: '1rem', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: '1rem' }}>Cotiza</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1 }}>
            {/* Dashboard — always visible */}
            <li style={{ marginBottom: '0.5rem' }}>
              <NavLink
                to="/dashboard"
                end
                style={({ isActive }) => ({
                  color: isActive ? '#00a89d' : '#fff',
                  textDecoration: 'none',
                  display: 'block',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 4,
                  background: isActive ? 'rgba(0,168,157,0.1)' : 'transparent',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: '0.9rem',
                })}
              >
                Dashboard
              </NavLink>
            </li>

            {/* Quotes section */}
            <li style={{ marginBottom: '0.25rem', padding: '0.5rem 0.75rem 0.25rem', fontSize: '0.85rem', color: '#fff', fontWeight: 700, letterSpacing: '0.02em' }}>
              Quotes
            </li>
            {quotesNavItems.map((item) => (
              <li key={item.to} style={{ marginBottom: '0.25rem', paddingLeft: '0.5rem' }}>
                <NavLink
                  to={item.to}
                  end={item.to === '/quotes'}
                  style={({ isActive }) => ({
                    color: isActive ? '#00a89d' : '#999',
                    textDecoration: 'none',
                    display: 'block',
                    padding: '0.4rem 0.75rem',
                    borderRadius: 4,
                    fontSize: '0.88rem',
                    background: isActive ? 'rgba(0,168,157,0.08)' : 'transparent',
                    position: 'relative',
                  })}
                >
                  {item.label}
                  {item.to === '/quotes/reviews' && pendingReviewCount > 0 && (
                    <span style={{
                      position: 'absolute',
                      right: 8,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: '#e74c3c',
                      color: '#fff',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      minWidth: 18,
                      height: 18,
                      borderRadius: 9,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 4px',
                      lineHeight: 1,
                    }}>
                      {pendingReviewCount > 99 ? '99+' : pendingReviewCount}
                    </span>
                  )}
                </NavLink>
              </li>
            ))}

            {/* Social Media section */}
            <li style={{ marginTop: '0.5rem', marginBottom: '0.25rem', padding: '0.5rem 0.75rem 0.25rem', fontSize: '0.85rem', color: '#fff', fontWeight: 700, letterSpacing: '0.02em' }}>
              Social Media
            </li>
            {socialNavItems.map((item) => (
              <li key={item.to} style={{ marginBottom: '0.25rem', paddingLeft: '0.5rem' }}>
                <NavLink
                  to={item.to}
                  style={({ isActive }) => ({
                    color: isActive ? '#00a89d' : '#999',
                    textDecoration: 'none',
                    display: 'block',
                    padding: '0.4rem 0.75rem',
                    borderRadius: 4,
                    fontSize: '0.88rem',
                    background: isActive ? 'rgba(0,168,157,0.08)' : 'transparent',
                  })}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div style={{ borderTop: '1px solid #333', paddingTop: '0.75rem', fontSize: '0.85rem' }}>
            <div style={{ marginBottom: '0.5rem', color: '#aaa' }}>{user?.email}</div>
            <button
              onClick={logout}
              style={{ background: 'none', border: '1px solid #666', color: '#ccc', padding: '0.35rem 0.75rem', borderRadius: 4, cursor: 'pointer', width: '100%' }}
            >
              Log out
            </button>
          </div>
        </nav>
        <main style={{ flex: 1, padding: '1.5rem', background: '#f5f5f5' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}