import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from '@mui/material/styles'
import Box from '@mui/material/Box'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import IconButton from '@mui/material/IconButton'
import Divider from '@mui/material/Divider'
import Typography from '@mui/material/Typography'
import Tooltip from '@mui/material/Tooltip'
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined'
import ShowChartOutlinedIcon from '@mui/icons-material/ShowChartOutlined'
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined'
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined'
import ChevronLeftOutlinedIcon from '@mui/icons-material/ChevronLeftOutlined'
import ChevronRightOutlinedIcon from '@mui/icons-material/ChevronRightOutlined'
import { useUser } from '../../hooks/useUser'

const EXPANDED_W = 240
const COLLAPSED_W = 56

export default function SidebarContent({ mobile = false, onClose }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const theme = useTheme()
  const { user } = useUser()

  const NAV_ITEMS = [
    { to: '/dashboard', label: 'Dashboard', Icon: DashboardOutlinedIcon },
    { to: '/assets',    label: 'Assets',    Icon: ShowChartOutlinedIcon },
    { to: '/alerts',    label: 'Alerts',    Icon: NotificationsOutlinedIcon },
    { to: '/settings',  label: 'Settings',  Icon: SettingsOutlinedIcon },
    { to: '/upgrade',   label: 'Upgrade',   Icon: BoltOutlinedIcon, highlight: true },
    ...(user?.is_admin === 1 ? [{ to: '/admin', label: 'Admin', Icon: AdminPanelSettingsOutlinedIcon }] : []),
  ]

  const [collapsed, setCollapsed] = useState(() => {
    if (mobile) return false
    return localStorage.getItem('ebp_sidebar_collapsed') === 'true'
  })

  useEffect(() => {
    if (!mobile) localStorage.setItem('ebp_sidebar_collapsed', collapsed)
  }, [collapsed, mobile])

  const width = mobile ? EXPANDED_W : collapsed ? COLLAPSED_W : EXPANDED_W

  const handleNav = (to) => {
    navigate(to)
    if (mobile && onClose) onClose()
  }

  return (
    <Box sx={{ width, display: 'flex', flexDirection: 'column', height: '100%', bgcolor: 'background.default', transition: 'width 0.2s', overflow: 'hidden' }}>
      {/* Logo */}
      <Box sx={{ px: collapsed && !mobile ? 0 : 2, py: 2.5, display: 'flex', alignItems: 'center', gap: 1.5, justifyContent: collapsed && !mobile ? 'center' : 'flex-start', minHeight: 56, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <img src="/favicon.svg" alt="EBP" style={{ width: 28, height: 28, flexShrink: 0 }} />
        {(!collapsed || mobile) && (
          <Typography variant="body1" sx={{ fontWeight: 700, color: 'text.primary', whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>
            EBP Tracker
          </Typography>
        )}
      </Box>

      {/* Nav */}
      <List sx={{ flex: 1, py: 1, px: collapsed && !mobile ? 0 : 0 }}>
        {NAV_ITEMS.map(({ to, label, Icon, highlight }) => {
          const active = pathname === to
          const iconColor = active ? theme.palette.primary.main : highlight ? theme.palette.warning.main : theme.palette.text.secondary
          const textColor = active ? theme.palette.text.primary : highlight ? theme.palette.warning.main : theme.palette.text.secondary
          const btn = (
            <ListItemButton
              selected={active}
              onClick={() => handleNav(to)}
              sx={{ justifyContent: collapsed && !mobile ? 'center' : 'flex-start', px: collapsed && !mobile ? 0 : undefined, minHeight: 40 }}
            >
              <ListItemIcon sx={{ minWidth: collapsed && !mobile ? 0 : 36, justifyContent: 'center', color: iconColor }}>
                <Icon fontSize="small" />
              </ListItemIcon>
              {(!collapsed || mobile) && (
                <ListItemText
                  primary={label}
                  primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: active ? 600 : 400, color: textColor }}
                />
              )}
            </ListItemButton>
          )
          return (
            <ListItem key={to} disablePadding>
              {collapsed && !mobile ? <Tooltip title={label} placement="right">{btn}</Tooltip> : btn}
            </ListItem>
          )
        })}
      </List>

      {/* Collapse toggle — desktop only */}
      {!mobile && (
        <>
          <Divider />
          <Box sx={{ display: 'flex', justifyContent: collapsed ? 'center' : 'flex-end', p: 1 }}>
            <IconButton size="small" onClick={() => setCollapsed(c => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
              {collapsed ? <ChevronRightOutlinedIcon fontSize="small" /> : <ChevronLeftOutlinedIcon fontSize="small" />}
            </IconButton>
          </Box>
        </>
      )}
    </Box>
  )
}
