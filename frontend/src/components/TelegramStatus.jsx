import Chip from '@mui/material/Chip'
import TelegramIcon from '@mui/icons-material/Telegram'

export default function TelegramStatus({ connected }) {
  return connected ? (
    <Chip icon={<TelegramIcon sx={{ fontSize: '14px !important' }} />} label="Telegram Connected" size="small"
      sx={{ bgcolor: '#001a12', color: '#00c896', border: '1px solid #00c896', borderRadius: '4px', fontWeight: 600, fontSize: '0.7rem' }} />
  ) : (
    <Chip icon={<TelegramIcon sx={{ fontSize: '14px !important' }} />} label="Not Connected" size="small"
      sx={{ bgcolor: '#0d0d0d', color: '#55556a', border: '1px solid #2a2a2a', borderRadius: '4px', fontWeight: 600, fontSize: '0.7rem' }} />
  )
}
