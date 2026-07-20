import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import Box from '@mui/material/Box'
import Drawer from '@mui/material/Drawer'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import SidebarContent from './Sidebar.jsx'
import Topbar from './Topbar.jsx'
import BottomNav from './BottomNav.jsx'
import ExpiryBanner from '../ExpiryBanner.jsx'

const PAGE_TITLES = {
  '/dashboard': 'Dashboard',
  '/assets':    'Assets',
  '/alerts':    'Alert History',
  '/settings':  'Settings',
  '/upgrade':   'Upgrade Plan',
  '/admin':     'Admin Panel',
}

const DRAWER_W = 240

export default function AppShell({ children }) {
  const { pathname } = useLocation()
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('lg'))
  const [mobileOpen, setMobileOpen] = useState(false)

  const pageTitle = PAGE_TITLES[pathname] || ''

  return (
    <Box sx={{ display: 'flex', height: '100vh', bgcolor: '#000000', overflow: 'hidden' }}>
      {/* Desktop permanent drawer */}
      {isDesktop && (
        <Drawer
          variant="permanent"
          sx={{
            flexShrink: 0,
            '& .MuiDrawer-paper': { position: 'relative', height: '100%', border: 'none', overflow: 'hidden' },
          }}
        >
          <SidebarContent />
        </Drawer>
      )}

      {/* Mobile temporary drawer */}
      {!isDesktop && (
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{ '& .MuiDrawer-paper': { width: DRAWER_W, border: 'none' } }}
        >
          <SidebarContent mobile onClose={() => setMobileOpen(false)} />
        </Drawer>
      )}

      {/* Main content area */}
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <Topbar
          pageTitle={pageTitle}
          plan="FREE"
          daysLeft={null}
          onMenuClick={() => setMobileOpen(true)}
        />
        <ExpiryBanner />
        <Box
          component="main"
          sx={{
            flex: 1,
            overflowY: 'auto',
            p: { xs: 2, lg: 3 },
            pb: { xs: 9, lg: 3 },
            bgcolor: '#000000',
          }}
        >
          {children}
        </Box>
      </Box>

      <BottomNav />
    </Box>
  )
}
