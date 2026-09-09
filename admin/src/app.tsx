import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppLayout } from './components/layout';
import { LoadingState } from './components/ui';
import { LoginPage } from './pages/login-page';
import { DashboardPage } from './pages/dashboard-page';
import { UsersPage } from './pages/users-page';
import { UserDetailPage } from './pages/user-detail-page';
import { ContentPage } from './pages/content-page';
import { MessagesPage } from './pages/messages-page';
import { ReportsPage } from './pages/reports-page';
import { AdminsPage } from './pages/admins-page';
import { AuditLogsPage } from './pages/audit-logs-page';
import { SettingsPage } from './pages/settings-page';
import { AnalyticsPage } from './pages/analytics-page';
import { SystemPage } from './pages/system-page';

function ProtectedRoute() {
  const { session, loading } = useAuth();
  if (loading) return <LoadingState label="Loading admin session…" />;
  if (!session) return <Navigate to="/login" replace />;
  return <AppLayout />;
}

export function App() {
  const { session } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/" element={<ProtectedRoute />}>
        <Route index element={<DashboardPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:id" element={<UserDetailPage />} />
        <Route path="content" element={<ContentPage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="admins" element={<AdminsPage />} />
        <Route path="audit-logs" element={<AuditLogsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="system" element={<SystemPage />} />
      </Route>
    </Routes>
  );
}
