import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { User, ErrorResponse } from 'shared';
import { verifySession, logout as apiLogout, clearToken, getToken, setToken, login as apiLogin, fetchSystemsStatus } from './api';
import { evaluateSystemsStatus, type SystemsStatus } from './systemsStatus';

interface AuthState {
  user: User | null;
  loading: boolean;
  systemsStatus: SystemsStatus;
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  recheckSystems: () => Promise<void>;
  recheckSystemsSilent: () => Promise<void>;
  skipInstagram: () => void;
  skipJobberSession: () => void;
  error: ErrorResponse | null;
  clearError: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [systemsStatus, setSystemsStatus] = useState<SystemsStatus>({ state: 'idle' });
  const [error, setError] = useState<ErrorResponse | null>(null);

  const runSystemsCheck = useCallback(async () => {
    setSystemsStatus({ state: 'checking' });
    try {
      const response = await fetchSystemsStatus();
      setSystemsStatus(evaluateSystemsStatus(response));
    } catch {
      setSystemsStatus({ state: 'error', message: 'Unable to verify external connections. Please try again.' });
    }
  }, []);

  // Check existing session on mount, then run systems check
  useEffect(() => {
    // Detect OAuth error query parameter
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('oauth_error');

    const token = getToken();
    if (!token) { setLoading(false); return; }

    verifySession()
      .then(async (res) => {
        if (res.valid && res.user) {
          setUser(res.user);
          setLoading(false);

          if (oauthError) {
            setSystemsStatus({ state: 'error', message: oauthError });
            // Clean up the query parameter
            const url = new URL(window.location.href);
            url.searchParams.delete('oauth_error');
            window.history.replaceState({}, '', url.pathname + url.search);
          } else {
            await runSystemsCheck();
          }
        } else {
          clearToken();
          setLoading(false);
        }
      })
      .catch(() => {
        clearToken();
        setLoading(false);
      });
  }, [runSystemsCheck]);

  const login = useCallback(async (email: string) => {
    setError(null);
    try {
      const res = await apiLogin(email);
      setToken(res.token);
      setUser(res.user);
      await runSystemsCheck();
    } catch (err) {
      setError(err as ErrorResponse);
      throw err;
    }
  }, [runSystemsCheck]);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setSystemsStatus({ state: 'idle' });
  }, []);

  const recheckSystems = useCallback(async () => {
    await runSystemsCheck();
  }, [runSystemsCheck]);

  /** Silent variant: re-fetches status without flashing the 'checking' spinner. */
  const recheckSystemsSilent = useCallback(async () => {
    try {
      const response = await fetchSystemsStatus();
      setSystemsStatus(evaluateSystemsStatus(response));
    } catch {
      // Silent check — don't overwrite current status on network error
    }
  }, []);

  const skipInstagram = useCallback(() => {
    setSystemsStatus({ state: 'ready' });
  }, []);

  const skipJobberSession = useCallback(() => {
    setSystemsStatus({ state: 'ready' });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return (
    <AuthContext.Provider value={{
      user, loading, systemsStatus, login, logout,
      recheckSystems, recheckSystemsSilent, skipInstagram, skipJobberSession, error, clearError,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
