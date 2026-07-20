import AppBar from '@mui/material/AppBar'
import Toolbar from '@mui/material/Toolbar'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import MenuIcon from '@mui/icons-material/Menu'
import { useUser, UserButton } from '@clerk/clerk-react'

const PLAN_SX = {
  FREE:   { bgcolor: '#0d0d0d', color: '#8888a8', border: '1px solid #2a2a2a' },
  COFFEE: { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
  BEER:   { bgcolor: '#001033', color: '#4488ff', border: '1px solid #4488ff' },
  WINE:   { bgcolor: '#110022', color: '#8855ff', border: '1px solid #8855ff' },
}

const PLAN_EMOJI = { FREE: '', COFFEE: '☕ ', BEER: '🍺 ', WINE: '🍷 ' }

export default function Topbar({ plan = 'FREE', daysLeft = null, pageTitle = '', onMenuClick }) {
  const { user } = useUser()

  return (
    <AppBar position="static" elevation={0} sx={{ bgcolor: '#000000', borderBottom: '1px solid #1a1a1a', zIndex: 1 }}>
      <Toolbar variant="dense" sx={{ minHeight: 56, px: { xs: 1.5, lg: 2.5 }, gap: 1 }}>
        {/* Hamburger — mobile only */}
        <IconButton onClick={onMenuClick} sx={{ display: { lg: 'none' }, mr: 0.5 }}>
          <MenuIcon fontSize="small" />
        </IconButton>

        {/* Mobile: centered wordmark */}
        <Typography variant="body1" sx={{ display: { xs: 'block', lg: 'none' }, fontWeight: 700, flex: 1, textAlign: 'center', color: '#e8e8f0', letterSpacing: '0.02em' }}>
          EBP Tracker
        </Typography>

        {/* Desktop: page title */}
        <Typography variant="h5" sx={{ display: { xs: 'none', lg: 'block' }, flex: 1, color: '#e8e8f0' }}>
          {pageTitle}
        </Typography>

        {/* Right: plan + expiry + avatar */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {daysLeft !== null && (
            <Typography variant="caption" sx={{ display: { xs: 'none', lg: 'block' }, color: '#55556a' }} className="tabular-nums">
              {daysLeft > 0 ? `${daysLeft}d left` : 'Expired'}
            </Typography>
          )}
          <Box sx={{ display: { xs: 'none', lg: 'block' } }}>
            <Chip
              label={`${PLAN_EMOJI[plan]}${plan}`}
              size="small"
              sx={{ borderRadius: '4px', fontWeight: 700, fontSize: '0.7rem', height: 22, ...PLAN_SX[plan] }}
            />
          </Box>
          <Typography variant="caption" sx={{ display: { xs: 'none', lg: 'block' }, color: '#8888a8' }}>
            {user?.firstName || user?.username}
          </Typography>
          <UserButton afterSignOutUrl="/" />
        </Box>
      </Toolbar>
    </AppBar>
  )
}
