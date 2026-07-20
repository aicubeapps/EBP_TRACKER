import { useState, useEffect, useCallback } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Alert from '@mui/material/Alert'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined'
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined'
import Paper from '@mui/material/Paper'
import { DataGrid } from '@mui/x-data-grid'
import { useAuth } from '@clerk/clerk-react'
import { api } from '../lib/api.js'

function NoRowsOverlay() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1 }}>
      <NotificationsNoneOutlinedIcon sx={{ fontSize: 40, color: '#2a2a2a' }} />
      <Typography variant="body2">No alerts fired yet. Add assets and connect Telegram to get started.</Typography>
    </Box>
  )
}

function fmtTime(ms) {
  if (!ms) return '—'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

const columns = [
  {
    field: 'fired_at', headerName: 'Time', width: 160,
    renderCell: (p) => <Typography variant="caption" sx={{ fontFamily: 'monospace', color: '#8888a8' }}>{fmtTime(p.value)}</Typography>,
  },
  {
    field: 'symbol', headerName: 'Symbol', width: 120,
    renderCell: (p) => <Typography variant="body2" sx={{ fontWeight: 600, color: '#e8e8f0' }} className="tabular-nums">{p.value}</Typography>,
  },
  {
    field: 'timeframe', headerName: 'TF', width: 70,
    renderCell: (p) => (
      <Chip label={p.value} size="small" sx={{ bgcolor: '#0d0d0d', color: '#8888a8', border: '1px solid #2a2a2a', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.7rem', fontWeight: 600, height: 20 }} />
    ),
  },
  {
    field: 'direction', headerName: 'Direction', width: 120,
    renderCell: (p) => (
      <Chip
        label={p.value === 'bull' ? 'BULL EBP' : 'BEAR EBP'}
        size="small"
        sx={{
          bgcolor: p.value === 'bull' ? '#001a12' : '#1a0008',
          color: p.value === 'bull' ? '#00c896' : '#ff4466',
          border: `1px solid ${p.value === 'bull' ? '#00c896' : '#ff4466'}`,
          borderRadius: '4px', fontWeight: 700, fontSize: '0.7rem', height: 20,
        }}
      />
    ),
  },
  {
    field: 'trend_bias', headerName: 'HTF Bias', width: 110,
    renderCell: (p) => {
      const aligned = p.row.direction === 'bull' ? p.value === 'bullish' : p.value === 'bearish'
      return aligned
        ? <CheckCircleOutlinedIcon sx={{ color: '#00c896', fontSize: 18 }} />
        : <WarningAmberOutlinedIcon sx={{ color: '#f5a623', fontSize: 18 }} />
    },
  },
  {
    field: 'candle_time', headerName: 'Candle', width: 160,
    renderCell: (p) => <Typography variant="caption" sx={{ fontFamily: 'monospace', color: '#55556a' }}>{fmtTime(p.value)}</Typography>,
  },
]

export default function Alerts() {
  const { getToken } = useAuth()
  const [rows, setRows]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)

  const fetchAlerts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const data  = await api.get('/alerts/history?limit=200', token)
      setRows(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { fetchAlerts() }, [fetchAlerts])

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      <Paper sx={{ border: '1px solid #1a1a1a', height: 600 }}>
        <DataGrid
          rows={rows}
          columns={columns}
          loading={loading}
          initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
          pageSizeOptions={[25, 50, 100]}
          disableRowSelectionOnClick
          slots={{ noRowsOverlay: NoRowsOverlay }}
          sx={{ border: 'none', height: '100%', '--DataGrid-overlayHeight': '300px' }}
        />
      </Paper>
    </Box>
  )
}
