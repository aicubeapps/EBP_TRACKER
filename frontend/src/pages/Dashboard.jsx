import { useState, useEffect, useCallback } from 'react'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Paper from '@mui/material/Paper'
import Button from '@mui/material/Button'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Alert from '@mui/material/Alert'
import { BarChart2 } from 'lucide-react'
import AssetCard from '../components/AssetCard.jsx'
import ExpiryBanner from '../components/ExpiryBanner.jsx'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@clerk/clerk-react'
import { api } from '../lib/api.js'

export default function Dashboard() {
  const navigate = useNavigate()
  const { getToken } = useAuth()
  const [data, setData]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)

  const fetchDashboard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const result = await api.get('/dashboard/', token)
      setData(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { fetchDashboard() }, [fetchDashboard])

  const assets = data?.assets ?? []

  return (
    <Box>
      <ExpiryBanner daysLeft={null} />
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading ? (
        <Stack spacing={1.5}>
          {[1, 2, 3].map((i) => <Skeleton key={i} variant="rounded" height={80} sx={{ bgcolor: '#0d0d0d' }} />)}
        </Stack>
      ) : assets.length === 0 ? (
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
          {assets.map((asset) => (
            <AssetCard key={asset.symbol} asset={{
              symbol: asset.symbol,
              type: asset.assetType,
              tfData: asset.tfStatus,
              displayName: asset.displayName,
            }} />
          ))}
        </Stack>
      )}
    </Box>
  )
}
