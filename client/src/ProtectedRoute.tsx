import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

export default function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>Loading…</div>;
  }

  if (!user) {
    // If the user was on a protected page, they likely had an expired session
    const isExpired = location.pathname !== '/login';
    return <Navigate to={isExpired ? (location.pathname.startsWith('/expenses/review/') ? '/login?expired=1&returnTo=' + encodeURIComponent(location.pathname + location.search) : '/login?expired=1') : '/login'} replace />;
  }

  return <Outlet />;
}
