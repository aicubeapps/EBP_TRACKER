import { useState } from 'react'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import FormControl from '@mui/material/FormControl'
import RadioGroup from '@mui/material/RadioGroup'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Divider from '@mui/material/Divider'
import TelegramIcon from '@mui/icons-material/Telegram'
import SendOutlinedIcon from '@mui/icons-material/SendOutlined'

const IS_WINE = false

export default function Settings() {
  const [telegramConnected] = useState(false)
  const [botCode, setBotCode] = useState('')
  const [alertMode, setAlertMode] = useState('aligned')

  return (
    <Box sx={{ maxWidth: 600 }}>
      <Stack spacing={3}>
        {/* Telegram */}
        <Paper sx={{ p: 3, border: '1px solid #1a1a1a' }}>
          <Typography variant="h6" gutterBottom>Telegram Alerts</Typography>
          {telegramConnected ? (
            <Alert severity="success" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
                <span>Connected — chat ID ••••1234</span>
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="outlined" color="success" startIcon={<SendOutlinedIcon />}>
                    Send Test
                  </Button>
                  <Button size="small" color="error">Disconnect</Button>
                </Stack>
              </Stack>
            </Alert>
          ) : (
            <>
              <Alert severity="info" sx={{ mb: 2 }}>
                Open @EBPTrackerBot in Telegram, tap Start, and enter the code shown below.
              </Alert>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                <Button variant="outlined" href="https://t.me/EBPTrackerBot" target="_blank" startIcon={<TelegramIcon />}>
                  Open Bot
                </Button>
                <TextField
                  placeholder="Enter 4-digit code"
                  size="small"
                  value={botCode}
                  onChange={(e) => setBotCode(e.target.value)}
                  inputProps={{ style: { fontFamily: 'monospace', letterSpacing: '0.2em' }, maxLength: 6 }}
                  sx={{ flex: 1 }}
                />
                <Button variant="contained" disabled={botCode.length < 4}>Connect</Button>
              </Stack>
            </>
          )}
        </Paper>

        <Divider />

        {/* Alert Mode */}
        <Paper sx={{ p: 3, border: '1px solid #1a1a1a' }}>
          <Typography variant="h6" gutterBottom>Alert Mode</Typography>
          <FormControl>
            <RadioGroup value={alertMode} onChange={(e) => setAlertMode(e.target.value)}>
              {[
                { value: 'aligned', label: 'Trend Aligned Only', desc: 'Alerts fire only when EBP matches TTrades HTF bias' },
                { value: 'all',     label: 'All Engulfing Bars', desc: 'Alerts fire for every EBP regardless of trend' },
              ].map((opt) => (
                <FormControlLabel
                  key={opt.value}
                  value={opt.value}
                  control={<Radio size="small" />}
                  label={
                    <Box sx={{ py: 0.5 }}>
                      <Typography variant="body1" sx={{ color: '#e8e8f0' }}>{opt.label}</Typography>
                      <Typography variant="caption">{opt.desc}</Typography>
                    </Box>
                  }
                  sx={{ mb: 1, mr: 0, p: 1, borderRadius: 1, border: '1px solid', borderColor: alertMode === opt.value ? '#4488ff' : '#1a1a1a', bgcolor: alertMode === opt.value ? '#001033' : 'transparent', transition: 'all 0.15s' }}
                />
              ))}
            </RadioGroup>
          </FormControl>
        </Paper>

        {/* Timeframe Pairing — Wine only */}
        <Paper sx={{ p: 3, border: '1px solid #1a1a1a', opacity: IS_WINE ? 1 : 0.4, pointerEvents: IS_WINE ? 'auto' : 'none' }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
            <Typography variant="h6">Custom TF Pairing</Typography>
            <Box sx={{ px: 1, py: 0.25, bgcolor: '#110022', border: '1px solid #8855ff', borderRadius: '4px' }}>
              <Typography variant="caption" sx={{ color: '#8855ff', fontSize: '0.65rem', fontWeight: 700 }}>🍷 WINE</Typography>
            </Box>
          </Stack>
          <Typography variant="body2" sx={{ mb: 2 }}>Select HTF bias source for each alert timeframe</Typography>
          {['M15', '1H', '4H', 'Daily'].map((tf) => (
            <Stack key={tf} direction="row" alignItems="center" spacing={2} sx={{ mb: 1.5 }}>
              <Typography variant="body2" sx={{ width: 48, color: '#e8e8f0' }}>{tf}</Typography>
              <Select size="small" defaultValue="auto" sx={{ minWidth: 160 }}>
                <MenuItem value="auto">Auto</MenuItem>
                <MenuItem value="W">Weekly</MenuItem>
                <MenuItem value="D">Daily</MenuItem>
                <MenuItem value="4H">4H</MenuItem>
              </Select>
            </Stack>
          ))}
        </Paper>
      </Stack>
    </Box>
  )
}
