import { useState } from 'react'
import Box from '@mui/material/Box'
import Grid from '@mui/material/Grid'
import MuiCard from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import TextField from '@mui/material/TextField'
import Alert from '@mui/material/Alert'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'

const TIERS = [
  { id: 'coffee', emoji: '☕', name: 'Coffee', price: 99,  assets: 5,  features: ['5 asset slots', 'All TFs (M15–W)', '30-day access', 'Telegram alerts'] },
  { id: 'beer',   emoji: '🍺', name: 'Beer',   price: 249, assets: 8,  features: ['8 asset slots', 'All TFs (M15–W)', '30-day access', 'Telegram alerts', 'Priority support'], recommended: true },
  { id: 'wine',   emoji: '🍷', name: 'Wine',   price: 499, assets: 13, features: ['13 asset slots', 'All TFs (M15–W)', '30-day access', 'Telegram alerts', 'Custom TF pairing', 'Priority support'] },
]

export default function Upgrade() {
  const [selectedTier, setSelectedTier] = useState(null)
  const [txRef, setTxRef] = useState('')

  return (
    <Box>
      <Typography variant="body2" sx={{ mb: 3 }}>
        Support EBP Tracker and unlock more asset slots. All plans are manual UPI payment — activated within 24 hours.
      </Typography>

      <Grid container spacing={2.5} justifyContent="center" sx={{ mb: 4 }}>
        {TIERS.map((tier) => (
          <Grid item xs={12} sm={6} md={4} key={tier.id}>
            <MuiCard
              onClick={() => setSelectedTier(tier.id)}
              sx={{
                border: selectedTier === tier.id ? '1px solid #4488ff' : tier.recommended ? '1px solid #2a2a2a' : '1px solid #1a1a1a',
                boxShadow: selectedTier === tier.id ? '0 0 16px rgba(68,136,255,0.2)' : 'none',
                cursor: 'pointer', height: '100%', position: 'relative',
                transition: 'all 0.15s',
              }}
            >
              {tier.recommended && (
                <Chip label="POPULAR" size="small" sx={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', bgcolor: '#4488ff', color: '#fff', fontWeight: 700, zIndex: 1 }} />
              )}
              <CardContent sx={{ textAlign: 'center', p: 3 }}>
                <Typography sx={{ fontSize: '2.5rem', mb: 1 }}>{tier.emoji}</Typography>
                <Typography variant="h4">{tier.name}</Typography>
                <Typography variant="h3" sx={{ my: 1.5, color: '#4488ff' }}>₹{tier.price}</Typography>
                <Typography variant="caption">per 30 days · {tier.assets} assets</Typography>
                <Divider sx={{ my: 2 }} />
                <Stack spacing={1} sx={{ mb: 3, textAlign: 'left' }}>
                  {tier.features.map((f) => (
                    <Stack key={f} direction="row" spacing={1} alignItems="center">
                      <CheckCircleOutlinedIcon sx={{ color: '#00c896', fontSize: 15 }} />
                      <Typography variant="body2" sx={{ color: '#e8e8f0' }}>{f}</Typography>
                    </Stack>
                  ))}
                </Stack>
                <Button variant={selectedTier === tier.id ? 'contained' : 'outlined'} fullWidth onClick={() => setSelectedTier(tier.id)}>
                  {selectedTier === tier.id ? 'Selected' : 'Pay via UPI'}
                </Button>
              </CardContent>
            </MuiCard>
          </Grid>
        ))}
      </Grid>

      {selectedTier && (
        <Paper sx={{ p: 3, maxWidth: 480, mx: 'auto', border: '1px solid #2a2a2a' }}>
          <Typography variant="h6" gutterBottom>Complete Payment</Typography>
          <Alert severity="info" sx={{ mb: 2 }}>
            Pay to the UPI ID below, then enter your transaction reference number.
          </Alert>
          <Box sx={{ bgcolor: '#0a0a0a', p: 1.5, borderRadius: 1, border: '1px solid #2a2a2a', mb: 2 }}>
            <Typography variant="caption" sx={{ color: '#8888a8', display: 'block', mb: 0.25 }}>UPI ID</Typography>
            <Typography sx={{ fontFamily: 'monospace', color: '#4488ff', fontSize: '0.9rem' }}>UPI_ID_PLACEHOLDER</Typography>
          </Box>
          <TextField fullWidth label="UPI Transaction Reference / UTR" value={txRef} onChange={(e) => setTxRef(e.target.value)} inputProps={{ style: { fontFamily: 'monospace' } }} sx={{ mb: 2 }} />
          <Button variant="contained" fullWidth disabled={txRef.length < 6}>Submit for Verification</Button>
        </Paper>
      )}
    </Box>
  )
}
