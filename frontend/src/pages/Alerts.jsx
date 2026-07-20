import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined'
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined'
import Paper from '@mui/material/Paper'
import { DataGrid } from '@mui/x-data-grid'

const PLACEHOLDER_ALERTS = [
  { id: 1, firedAt: '2026-07-20 14:30', symbol: 'EURUSD',   timeframe: '1H', direction: 'bull', trendAligned: true,  candleTime: '2026-07-20 14:00' },
  { id: 2, firedAt: '2026-07-20 10:15', symbol: 'XAUUSD',   timeframe: '4H', direction: 'bear', trendAligned: false, candleTime: '2026-07-20 08:00' },
  { id: 3, firedAt: '2026-07-19 21:00', symbol: 'RELIANCE', timeframe: 'D',  direction: 'bull', trendAligned: true,  candleTime: '2026-07-19 00:00' },
]

function NoRowsOverlay() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1 }}>
      <NotificationsNoneOutlinedIcon sx={{ fontSize: 40, color: '#2a2a2a' }} />
      <Typography variant="body2">No alerts fired yet. Add assets and connect Telegram to get started.</Typography>
    </Box>
  )
}

const columns = [
  {
    field: 'firedAt', headerName: 'Time', width: 160,
    renderCell: (p) => <Typography variant="caption" sx={{ fontFamily: 'monospace', color: '#8888a8' }}>{p.value}</Typography>,
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
    field: 'trendAligned', headerName: 'Aligned', width: 90,
    renderCell: (p) => p.value
      ? <CheckCircleOutlinedIcon sx={{ color: '#00c896', fontSize: 18 }} />
      : <WarningAmberOutlinedIcon sx={{ color: '#f5a623', fontSize: 18 }} />,
  },
  {
    field: 'candleTime', headerName: 'Candle', width: 160,
    renderCell: (p) => <Typography variant="caption" sx={{ fontFamily: 'monospace', color: '#55556a' }}>{p.value}</Typography>,
  },
]

export default function Alerts() {
  return (
    <Paper sx={{ border: '1px solid #1a1a1a', height: 600 }}>
      <DataGrid
        rows={PLACEHOLDER_ALERTS}
        columns={columns}
        initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
        pageSizeOptions={[25, 50, 100]}
        disableRowSelectionOnClick
        slots={{ noRowsOverlay: NoRowsOverlay }}
        sx={{ border: 'none', height: '100%', '--DataGrid-overlayHeight': '300px' }}
      />
    </Paper>
  )
}
