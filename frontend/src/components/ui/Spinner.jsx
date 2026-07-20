import CircularProgress from '@mui/material/CircularProgress'
import Box from '@mui/material/Box'

const SIZE_MAP = { sm: 16, md: 24, lg: 32 }

export default function Spinner({ size = 'md' }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
      <CircularProgress size={SIZE_MAP[size]} color="primary" />
    </Box>
  )
}
