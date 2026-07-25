import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useClerk } from '@clerk/clerk-react';
import { useUser } from '../hooks/useUser';
import { daysRemaining, capitalise } from '../lib/utils';
import ExpiryBanner from './ExpiryBanner';
import logoSrc from '../assets/logo.svg';

const NAV = [
  { id: 'nav-dash',     path: '/dashboard', icon: '📊', label: 'Dashboard' },
  { id: 'nav-assets',   path: '/assets',    icon: '📋', label: 'Assets' },
  { id: 'nav-alerts',   path: '/alerts',    icon: '🔔', label: 'Alerts' },
  { id: 'nav-settings', path: '/settings',  icon: '⚙️', label: 'Settings' },
];

export default function Layout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user }  = useUser();
  const { signOut } = useClerk();
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const nav = [...NAV];
  if (user?.is_admin === 1) {
    nav.push({ id: 'nav-admin', path: '/admin', icon: '🛡️', label: 'Admin' });
  }

  const initials = user?.name
    ? user.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : '?';

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="topbar-brand">
          <h1>FOREX ALERT MANAGER</h1>
          <p>REAL-TIME SIGNAL TRACKER</p>
        </div>
        <div className="topbar-user" onClick={() => setDropdownOpen(o => !o)}>
          <span className="topbar-user-name">{user?.name ?? ''}</span>
          <div className="user-avatar">{initials}</div>
          <div className={`user-dropdown ${dropdownOpen ? 'open' : ''}`}>
            <div className="user-dropdown-plan">
              {capitalise(user?.plan) || 'Free'} · {daysRemaining(user?.expires_at)} days left
            </div>
            <button className="user-dropdown-signout" onClick={() => signOut()}>
              Sign Out
            </button>
          </div>
        </div>
      </div>

      <div className="app-body">
        <nav className="sidebar">
          <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
            <img src={logoSrc} alt="EBP Tracker" style={{ width: 56, height: 56, borderRadius: '50%' }} />
          </div>
          <div className="sidebar-section">Navigation</div>
          {nav.map(item => (
            <button
              key={item.id}
              id={item.id}
              className={`nav-item ${location.pathname === item.path ? 'active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              <span className="ni-icon">{item.icon}</span>
              <span className="ni-label">{item.label}</span>
            </button>
          ))}
          <div className="sidebar-footer">
            <p>EBP TRACKER</p>
            <p>FOREX ALERT MANAGER</p>
          </div>
        </nav>

        <main className="content">
          <ExpiryBanner />
          {children}
        </main>
      </div>
    </div>
  );
}
