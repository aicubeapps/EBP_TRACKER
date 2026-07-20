import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import { useNavigate } from 'react-router-dom'

export default function NotFound() {
  const navigate = useNavigate()
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: '#000000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', px: 2 }}>
      <Typography variant="h1" sx={{ fontSize: '5rem', fontWeight: 800, color: '#1a1a1a', mb: 1 }} className="tabular-nums">404</Typography>
      <Typography variant="h4" sx={{ mb: 1 }}>Page not found</Typography>
      <Typography variant="body2" sx={{ mb: 3 }}>The page you're looking for doesn't exist.</Typography>
      <Button variant="contained" onClick={() => navigate('/dashboard')}>Return to Dashboard</Button>
    </Box>
  )
}
