import Chip from '@mui/material/Chip'

export default function EBPBadge({ direction }) {
  if (direction === 'bull') {
    return (
      <Chip label="BULL EBP" size="small"
        sx={{ bgcolor: '#001a12', color: '#00c896', border: '1px solid #00c896', borderRadius: '4px', fontWeight: 700, fontSize: '0.7rem' }} />
    )
  }
  if (direction === 'bear') {
    return (
      <Chip label="BEAR EBP" size="small"
        sx={{ bgcolor: '#1a0008', color: '#ff4466', border: '1px solid #ff4466', borderRadius: '4px', fontWeight: 700, fontSize: '0.7rem' }} />
    )
  }
  return (
    <Chip label="NONE" size="small"
      sx={{ bgcolor: '#0d0d0d', color: '#55556a', border: '1px solid #2a2a2a', borderRadius: '4px', fontWeight: 600, fontSize: '0.7rem' }} />
  )
}
