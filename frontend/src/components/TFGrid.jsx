import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Stack from '@mui/material/Stack'

const TIMEFRAMES = ['M15', '1H', '4H', 'D', 'W']

const DOT_COLOR = { bull: '#00c896', bear: '#ff4466', none: '#2a2a2a' }
const DOT_GLOW  = { bull: '0 0 6px #00c896', bear: '0 0 6px #ff4466', none: 'none' }
const LABEL_COLOR = { bull: '#00c896', bear: '#ff4466', none: '#55556a' }

function TFCell({ tf, signal = 'none' }) {
  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      px: 1.5, py: 1,
      border: '1px solid #1a1a1a',
      borderRadius: 1,
      bgcolor: '#0a0a0a',
      minWidth: 44,
      flex: 1,
    }}>
      <Typography variant="overline" sx={{ fontSize: '0.6rem', color: LABEL_COLOR[signal], lineHeight: 1.2 }}>
        {tf}
      </Typography>
      <Box sx={{
        width: 8, height: 8, borderRadius: '50%', mt: 0.75,
        bgcolor: DOT_COLOR[signal],
        boxShadow: DOT_GLOW[signal],
      }} />
    </Box>
  )
}

export default function TFGrid({ data = {} }) {
  return (
    <Stack direction="row" spacing={0.75}>
      {TIMEFRAMES.map((tf) => (
        <TFCell key={tf} tf={tf} signal={data[tf] || 'none'} />
      ))}
    </Stack>
  )
}
