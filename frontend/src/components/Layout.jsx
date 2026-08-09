import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useClerk, useAuth } from '@clerk/clerk-react';
import { useUser } from '../hooks/useUser';
import { daysRemaining, capitalise } from '../lib/utils';
import ExpiryBanner from './ExpiryBanner';
import api from '../lib/api';
import logoSrc from '../assets/logo.jpeg';

function fmtTZ(ts, tz, locale) {
  if (!ts) return null;
  return new Date(ts).toLocaleTimeString(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

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
  const { getToken } = useAuth();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [lastApiCall, setLastApiCall]   = useState(null);
  const [sidebarOpen, setSidebarOpen]   = useState(false);

  const fetchApiStatus = useCallback(async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/health/datasources', token);
      const calls = Object.values(data.sources ?? {}).map(s => s.lastCall).filter(Boolean);
      if (calls.length > 0) setLastApiCall(Math.max(...calls));
    } catch {}
  }, [getToken]);

  useEffect(() => {
    fetchApiStatus();
    const iv = setInterval(fetchApiStatus, 60_000);
    return () => clearInterval(iv);
  }, [fetchApiStatus]);

  useEffect(() => setSidebarOpen(false), [location.pathname]);

  const nav = [...NAV];
  nav.push({ id: 'nav-market', path: '/market', icon: '📡', label: 'Market' });
  if (user?.is_admin === 1) {
    nav.push({ id: 'nav-admin',  path: '/admin',  icon: '🛡️', label: 'Admin' });
  }

  const initials = user?.name
    ? user.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : '?';

  return (
    <div className="app-shell">
      <div className="topbar">
        <button
          className="hamburger"
          aria-label="Toggle navigation"
          onClick={() => setSidebarOpen(o => !o)}
        >☰</button>
        <div className="topbar-brand">
          <h1>FOREX ALERT MANAGER</h1>
          <p>REAL-TIME SIGNAL TRACKER</p>
        </div>
        {lastApiCall && (
          <span className="text-mono text-muted" style={{ fontSize: 11 }}>
            Last call: {fmtTZ(lastApiCall, 'America/New_York', 'en-US')} NY
            {' · '}{fmtTZ(lastApiCall, 'Asia/Kolkata', 'en-IN')} IST
          </span>
        )}
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
        <nav className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`}>
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

        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}
        <main className="content">
          <ExpiryBanner />
          {children}
        </main>
      </div>
    </div>
  );
}
