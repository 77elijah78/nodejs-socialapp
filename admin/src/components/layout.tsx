import { NavLink, Outlet } from 'react-router-dom';
import { Shield, Users, LayoutDashboard, FileText, MessageSquare, Flag, Lock, Settings, ChartNoAxesCombined, Activity, LogOut } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { hasPermission } from '../lib/permissions';
import { Button } from './ui';

const navigation = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'view:dashboard' },
  { to: '/users', label: 'Users', icon: Users, permission: 'view:users' },
  { to: '/content', label: 'Content', icon: FileText, permission: 'view:posts' },
  { to: '/messages', label: 'Messages', icon: MessageSquare, permission: 'view:messages' },
  { to: '/reports', label: 'Reports', icon: Flag, permission: 'view:reports' },
  { to: '/admins', label: 'Admins', icon: Shield, permission: 'manage:admins' },
  { to: '/audit-logs', label: 'Audit Logs', icon: Lock, permission: 'view:audit_logs' },
  { to: '/settings', label: 'Settings', icon: Settings, permission: 'manage:settings' },
  { to: '/analytics', label: 'Analytics', icon: ChartNoAxesCombined, permission: 'view:analytics' },
  { to: '/system', label: 'System', icon: Activity, permission: 'view:system_monitoring' },
];

export function AppLayout() {
  const { session, signOut } = useAuth();
  const permissions = session?.adminAccount.permissions ?? [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <strong>Social Admin</strong>
            <span>Operations console</span>
          </div>
        </div>

        <nav className="nav">
          {navigation.filter((item) => hasPermission(permissions, item.permission)).map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                <Icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="profile-mini">
            <div className="avatar">{session?.adminAccount.user.username.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{session?.adminAccount.user.displayName || session?.adminAccount.user.username}</strong>
              <span>{session?.adminAccount.role.replaceAll('_', ' ')}</span>
            </div>
          </div>
          <Button kind="secondary" onClick={() => void signOut()}>
            <LogOut size={16} /> Sign out
          </Button>
        </div>
      </aside>
      <main className="content-area">
        <Outlet />
      </main>
    </div>
  );
}
