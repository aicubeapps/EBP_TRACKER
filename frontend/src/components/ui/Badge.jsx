import Chip from '@mui/material/Chip'

const VARIANT_SX = {
  bull:    { bgcolor: '#001a12', color: '#00c896', border: '1px solid #00c896' },
  bear:    { bgcolor: '#1a0008', color: '#ff4466', border: '1px solid #ff4466' },
  neutral: { bgcolor: '#0d0d0d', color: '#8888a8', border: '1px solid #2a2a2a' },
  blue:    { bgcolor: '#001033', color: '#4488ff', border: '1px solid #4488ff' },
  yellow:  { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
  purple:  { bgcolor: '#110022', color: '#8855ff', border: '1px solid #8855ff' },
  expired: { bgcolor: '#1a0008', color: '#ff4466', border: '1px solid #ff4466' },
  free:    { bgcolor: '#0d0d0d', color: '#8888a8', border: '1px solid #2a2a2a' },
  coffee:  { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
  beer:    { bgcolor: '#001033', color: '#4488ff', border: '1px solid #4488ff' },
  wine:    { bgcolor: '#110022', color: '#8855ff', border: '1px solid #8855ff' },
}

export default function Badge({ variant = 'neutral', children, sx = {} }) {
  return (
    <Chip
      label={children}
      size="small"
      sx={{ borderRadius: '4px', fontWeight: 700, fontSize: '0.7rem', ...VARIANT_SX[variant], ...sx }}
    />
  )
}
