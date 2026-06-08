import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function LoginPage() {
  const { login, error, clearError } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const expired = searchParams.get('expired') === '1';

  const [email, setEmail] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    setClientError(null);

    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setClientError('Please enter your email address.');
      return;
    }
    if (!trimmed.endsWith('@chicago-reno.com')) {
      setClientError('Only @chicago-reno.com email addresses are permitted.');
      return;
    }

    setSubmitting(true);
    try {
      await login(trimmed);
      navigate('/dashboard', { replace: true });
    } catch {
      // error is set in AuthContext
    } finally {
      setSubmitting(false);
    }
  };

  const displayError = clientError ?? (error ? error.message : null);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#0a1e24' }}>
      <form onSubmit={handleSubmit} style={{ background: '#fff', padding: '2rem', borderRadius: 8, width: 380 }}>
        <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem' }}>Cotiza</h1>
        <p style={{ margin: '0 0 1.5rem', color: '#666', fontSize: '0.9rem' }}>Sign in to Cotiza</p>

        {expired && !displayError && (
          <div role="alert" style={{ background: '#fff3e0', color: '#e65100', padding: '0.6rem 0.75rem', borderRadius: 4, marginBottom: '1rem', fontSize: '0.85rem' }}>
            Your session has expired. Please log in again.
          </div>
        )}

        {displayError && (
          <div role="alert" style={{ background: '#fdecea', color: '#c62828', padding: '0.6rem 0.75rem', borderRadius: 4, marginBottom: '1rem', fontSize: '0.85rem' }}>
            {displayError}
            {error?.actions && error.actions.length > 0 && (
              <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
                {error.actions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            )}
          </div>
        )}

        <label htmlFor="email" style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 500, fontSize: '0.9rem' }}>Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@chicago-reno.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          style={{ width: '100%', padding: '0.6rem', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.95rem', boxSizing: 'border-box' }}
        />

        <button
          type="submit"
          disabled={submitting}
          style={{ marginTop: '1rem', width: '100%', padding: '0.65rem', background: '#0a1e24', color: '#fff', border: 'none', borderRadius: 4, fontSize: '0.95rem', cursor: submitting ? 'wait' : 'pointer' }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
