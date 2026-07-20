import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Paper from '@mui/material/Paper'
import Button from '@mui/material/Button'
import Box from '@mui/material/Box'
import { BarChart2 } from 'lucide-react'
import AssetCard from '../components/AssetCard.jsx'
import ExpiryBanner from '../components/ExpiryBanner.jsx'
import { useNavigate } from 'react-router-dom'
import { useAssets } from '../hooks/useAssets.js'
import Skeleton from '@mui/material/Skeleton'

const PLACEHOLDER_ASSETS = [
  { symbol: 'EURUSD',   type: 'Forex',     tfData: { M15: 'bull', '1H': 'bull', '4H': 'none', D: 'none', W: 'bear' }, lastAlert: '2h ago' },
  { symbol: 'XAUUSD',   type: 'Commodity', tfData: { M15: 'none', '1H': 'bear', '4H': 'bear', D: 'none', W: 'none' }, lastAlert: '5h ago' },
  { symbol: 'RELIANCE', type: 'NSE Asset', tfData: { M15: 'none', '1H': 'none', '4H': 'bull', D: 'bull', W: 'none' }, lastAlert: 'Yesterday' },
]

export default function Dashboard() {
  const navigate = useNavigate()
  const { assets, loading } = useAssets()
  const displayAssets = assets.length > 0 ? assets : PLACEHOLDER_ASSETS

  return (
    <Box>
      <ExpiryBanner daysLeft={null} />
      {loading ? (
        <Stack spacing={1.5}>
          {[1, 2, 3].map((i) => <Skeleton key={i} variant="rounded" height={80} sx={{ bgcolor: '#0d0d0d' }} />)}
        </Stack>
      ) : displayAssets.length === 0 ? (
        <Paper sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 8, textAlign: 'center', border: '1px solid #1a1a1a' }}>
          <Box sx={{ width: 48, height: 48, borderRadius: 2, bgcolor: '#0d0d0d', border: '1px solid #1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 2 }}>
            <BarChart2 size={20} color="#55556a" />
          </Box>
          <Typography variant="h5" sx={{ mb: 0.5 }}>No assets tracked yet</Typography>
          <Typography variant="body2" sx={{ mb: 3, maxWidth: 300 }}>Add your first asset to start receiving engulfing bar print alerts.</Typography>
          <Button variant="contained" onClick={() => navigate('/assets')}>Add Asset</Button>
        </Paper>
      ) : (
        <Stack spacing={1.5}>
          {displayAssets.map((asset) => (
            <AssetCard key={asset.symbol} asset={asset} />
          ))}
        </Stack>
      )}
    </Box>
  )
}
