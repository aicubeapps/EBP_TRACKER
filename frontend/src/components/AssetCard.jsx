import MuiCard from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Grid from '@mui/material/Grid'
import Stack from '@mui/material/Stack'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Chip from '@mui/material/Chip'
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined'
import TFGrid from './TFGrid.jsx'

const TYPE_SX = {
  Forex:       { bgcolor: '#001033', color: '#4488ff', border: '1px solid #4488ff' },
  Commodity:   { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
  Index:       { bgcolor: '#110022', color: '#8855ff', border: '1px solid #8855ff' },
  'NSE Asset': { bgcolor: '#0d0d0d', color: '#8888a8', border: '1px solid #2a2a2a' },
  Crypto:      { bgcolor: '#1a1100', color: '#f5a623', border: '1px solid #f5a623' },
}

function getCardGlow(tfData) {
  const signals = Object.values(tfData || {})
  if (signals.includes('bull')) return { border: '1px solid #00c896', boxShadow: '0 0 12px rgba(0,200,150,0.15)' }
  if (signals.includes('bear')) return { border: '1px solid #ff4466', boxShadow: '0 0 12px rgba(255,68,102,0.15)' }
  return { border: '1px solid #1a1a1a', boxShadow: 'none' }
}

export default function AssetCard({ asset, onRemove }) {
  const { symbol, type, tfData = {}, lastAlert } = asset
  const glowSx = getCardGlow(tfData)

  return (
    <MuiCard sx={{ ...glowSx, bgcolor: '#0a0a0a', backgroundImage: 'none', borderRadius: 2 }}>
      <CardContent sx={{ p: { xs: 2, lg: 2.5 }, '&:last-child': { pb: { xs: 2, lg: 2.5 } } }}>
        <Grid container alignItems="center" spacing={2}>
          {/* Left: symbol + type */}
          <Grid item xs={12} lg={3}>
            <Stack direction={{ xs: 'row', lg: 'column' }} alignItems={{ xs: 'center', lg: 'flex-start' }} justifyContent="space-between">
              <Box>
                <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em', color: '#e8e8f0', lineHeight: 1.2 }} className="tabular-nums">
                  {symbol}
                </Typography>
                <Chip label={type} size="small" sx={{ mt: 0.75, borderRadius: '4px', fontWeight: 600, fontSize: '0.7rem', height: 20, ...TYPE_SX[type] }} />
              </Box>
              {/* Mobile delete */}
              <IconButton size="small" onClick={() => onRemove?.(symbol)} sx={{ display: { xs: 'flex', lg: 'none' }, color: '#55556a', '&:hover': { color: '#ff4466' } }}>
                <DeleteOutlineOutlinedIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Grid>

          {/* Center: TFGrid */}
          <Grid item xs={12} lg={6}>
            <TFGrid data={tfData} />
          </Grid>

          {/* Right: last alert + desktop delete */}
          <Grid item xs={12} lg={3}>
            <Stack direction={{ xs: 'row', lg: 'column' }} alignItems={{ xs: 'center', lg: 'flex-end' }} justifyContent="space-between" spacing={0.5}>
              <Box sx={{ textAlign: { xs: 'left', lg: 'right' } }}>
                <Typography variant="overline" sx={{ color: '#55556a', display: 'block', lineHeight: 1.2 }}>Last alert</Typography>
                <Typography variant="caption" sx={{ color: '#8888a8' }} className="tabular-nums">
                  {lastAlert || 'None yet'}
                </Typography>
              </Box>
              <IconButton size="small" onClick={() => onRemove?.(symbol)} sx={{ display: { xs: 'none', lg: 'flex' }, color: '#55556a', '&:hover': { color: '#ff4466' } }}>
                <DeleteOutlineOutlinedIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Grid>
        </Grid>
      </CardContent>
    </MuiCard>
  )
}
