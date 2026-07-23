import { useNavigate, useLocation } from 'react-router-dom';
import {
  Paper, BottomNavigation, BottomNavigationAction
} from '@mui/material';
import {
  DashboardOutlined,
  NotificationsOutlined, SettingsOutlined,
  AdminPanelSettingsOutlined
} from '@mui/icons-material';
import { useUser } from '../../hooks/useUser';

export default function BottomNav() {
  const navigate     = useNavigate();
  const { pathname } = useLocation();
  const { user }     = useUser();

  const NAV_ITEMS = [
    { label: 'Dashboard', icon: <DashboardOutlined />,    path: '/dashboard' },
    { label: 'Alerts',   icon: <NotificationsOutlined />, path: '/alerts' },
    { label: 'Settings', icon: <SettingsOutlined />,      path: '/settings' },
    ...(user?.is_admin === 1 ? [{ label: 'Admin', icon: <AdminPanelSettingsOutlined />, path: '/admin' }] : []),
  ];

  const currentIndex = NAV_ITEMS.findIndex(i => i.path === pathname);

  return (
    <Paper sx={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      display: { xs: 'block', lg: 'none' },
      zIndex: 1200,
      borderTop: '1px solid #1a1a1a',
      bgcolor: '#000000',
    }} elevation={0}>
      <BottomNavigation
        value={currentIndex === -1 ? false : currentIndex}
        onChange={(_, idx) => navigate(NAV_ITEMS[idx].path)}
        sx={{
          bgcolor: '#000000',
          '& .MuiBottomNavigationAction-root': {
            color: '#55556a',
            minWidth: 0,
            '&.Mui-selected': { color: '#4488ff' },
          },
          '& .MuiBottomNavigationAction-label': {
            fontSize: '0.6rem',
          },
        }}
      >
        {NAV_ITEMS.map(item => (
          <BottomNavigationAction
            key={item.path}
            label={item.label}
            icon={item.icon}
          />
        ))}
      </BottomNavigation>
    </Paper>
  );
}
