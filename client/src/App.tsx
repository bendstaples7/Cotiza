import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { AuthProvider } from './AuthContext';
import { ErrorToastProvider } from './ErrorToast';
import ProtectedRoute from './ProtectedRoute';
import Layout from './Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import MediaLibraryPage from './pages/MediaLibraryPage';
import PostDetailPage from './pages/PostDetailPage';
import QuickPostPage from './pages/QuickPostPage';
import SettingsPage from './pages/SettingsPage';
import ActivityLogPage from './pages/ActivityLogPage';
import QuoteInputPage from './pages/QuoteInputPage';
import QuoteDraftPage from './pages/QuoteDraftPage';
import QuotesHubPage from './pages/QuotesHubPage';
import QuoteDraftsListPage from './pages/QuoteDraftsListPage';
import ManualFallbackPage from './pages/ManualFallbackPage';
import RulesPage from './pages/RulesPage';
import RequestQueuePage from './pages/RequestQueuePage';
import DeathclockDashboardPage from './pages/DeathclockDashboardPage';
import PlaceholderPage from './pages/PlaceholderPage';
import ReviewQueuePage from './pages/ReviewQueuePage';

function LegacyPostRedirect() {
  const { id } = useParams();
  return <Navigate to={`/social/posts/${id}`} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ErrorToastProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<Layout />}>
                {/* Main Dashboard — homepage */}
                <Route path="/dashboard" element={<DeathclockDashboardPage />} />

                {/* Social Media section */}
                <Route path="/social/dashboard" element={<DashboardPage />} />
                <Route path="/social/posts/quick" element={<QuickPostPage />} />
                <Route path="/social/posts/:id" element={<PostDetailPage />} />
                <Route path="/social/media" element={<MediaLibraryPage />} />
                <Route path="/social/settings" element={<SettingsPage />} />
                <Route path="/social/activity-log" element={<ActivityLogPage />} />

                {/* Quotes section */}
                <Route path="/quotes/requests" element={<RequestQueuePage />} />
                <Route path="/quotes/queue" element={<Navigate to="/quotes/requests" replace />} />
                <Route path="/quotes/reviews" element={<ReviewQueuePage />} />
                <Route path="/quotes" element={<QuotesHubPage />} />
                <Route path="/quotes/new" element={<QuoteInputPage />} />
                <Route path="/quotes/drafts" element={<QuoteDraftsListPage />} />
                <Route path="/quotes/drafts/:id" element={<QuoteDraftPage />} />
                <Route path="/quotes/rules" element={<RulesPage />} />
                <Route path="/quotes/catalog" element={<ManualFallbackPage />} />
              </Route>
            </Route>
            {/* Redirect legacy routes to new paths */}
            <Route path="/posts/quick" element={<Navigate to="/social/posts/quick" replace />} />
            <Route path="/posts/:id" element={<LegacyPostRedirect />} />
            <Route path="/media" element={<Navigate to="/social/media" replace />} />
            <Route path="/settings" element={<Navigate to="/social/settings" replace />} />
            <Route path="/activity-log" element={<Navigate to="/social/activity-log" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </ErrorToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}