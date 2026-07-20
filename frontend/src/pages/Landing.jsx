import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import { SignInButton } from '@clerk/clerk-react'
import { useParams } from 'react-router-dom'

export default function Landing() {
  const { token } = useParams()

  return (
    <Box sx={{
      minHeight: '100vh',
      bgcolor: '#000000',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundImage: 'radial-gradient(circle at 1px 1px, #1a1a1a 1px, transparent 0)',
      backgroundSize: '32px 32px',
      px: 2,
      position: 'relative',
      '&::before': {
        content: '""',
        position: 'absolute',
        inset: 0,
        background: 'radial-gradient(ellipse at center, rgba(68,136,255,0.05) 0%, transparent 70%)',
        pointerEvents: 'none',
      },
    }}>
      <Box sx={{ position: 'relative', textAlign: 'center', maxWidth: 480 }}>
        <img src="/favicon.svg" alt="EBP Tracker" style={{ width: 64, height: 64, marginBottom: 24 }} />

        <Typography variant="h2" sx={{ fontSize: { xs: '2rem', sm: '2.5rem' }, fontWeight: 700, color: '#e8e8f0', mb: 1.5, letterSpacing: '-0.03em' }}>
          EBP Tracker
        </Typography>

        <Typography variant="body1" sx={{ color: '#8888a8', mb: 0.75 }}>
          Precision alerts for engulfing bar prints.
        </Typography>
        <Typography variant="caption" sx={{ color: '#55556a', display: 'block', mb: 4 }}>
          Forex · Commodities · Indices · Indian Markets
        </Typography>

        {token && (
          <Box sx={{ mb: 3, px: 2, py: 1.5, bgcolor: '#001033', border: '1px solid #4488ff', borderRadius: 1 }}>
            <Typography variant="caption" sx={{ color: '#4488ff' }}>
              Invite token active: <strong style={{ fontFamily: 'monospace' }}>{token}</strong>
            </Typography>
          </Box>
        )}

        <SignInButton mode="modal" redirectUrl="/dashboard">
          <Button
            variant="contained"
            size="large"
            sx={{ px: 4, py: 1.5, fontSize: '0.9375rem', fontWeight: 600, borderRadius: 2, boxShadow: '0 4px 24px rgba(68,136,255,0.3)' }}
            startIcon={
              <svg viewBox="0 0 24 24" style={{ width: 20, height: 20 }} fill="white">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            }
          >
            Sign in with Google
          </Button>
        </SignInButton>

        <Typography variant="caption" sx={{ display: 'block', mt: 4, color: '#55556a' }}>
          Invite only access · By invitation only
        </Typography>
      </Box>
    </Box>
  )
}
