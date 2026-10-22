import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { API_BASE } from '../api';

type GoogleIdentity = { initialize: (options: { client_id: string; nonce: string; callback: (response: { credential: string }) => void }) => void; renderButton: (element: HTMLElement, options: { type: string; size: string }) => void };

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const button = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onerror = () => { if (active) setError('Google sign-in could not load. Reload to try again.'); };
    script.onload = async () => {
      try {
        const response = await fetch(API_BASE + '/api/auth/google-challenge');
        if (!response.ok) throw new Error();
        const { clientId, nonce } = await response.json();
        if (!active || !button.current) return;
        const google = (window as unknown as { google: { accounts: { id: GoogleIdentity } } }).google.accounts.id;
        google.initialize({ client_id: clientId, nonce, callback: async ({ credential }) => {
          try {
            await login(JSON.stringify({ credential, nonce }));
            if (!active) return;
            const returnTo = params.get('returnTo');
            navigate(returnTo && /^\/expenses\/review\/[a-f0-9-]{36}$/.test(returnTo) ? returnTo : '/dashboard', { replace: true });
          } catch { if (active) setError('Google sign-in failed. Reload and use your Chicago Reno Google account.'); }
        }});
        google.renderButton(button.current, { type: 'standard', size: 'large' });
      } catch { if (active) setError('Google sign-in is unavailable. Please contact your administrator.'); }
    };
    document.head.appendChild(script);
    return () => { active = false; script.remove(); };
  }, [login, navigate, params]);
  return <main style={{ maxWidth: 380, margin: '15vh auto', padding: '2rem' }}><h1>Cotiza</h1><p>Sign in with your Chicago Reno Google account.</p><div ref={button} />{error && <p role="alert">{error}</p>}</main>;
}
