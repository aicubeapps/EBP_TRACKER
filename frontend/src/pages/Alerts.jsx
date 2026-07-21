import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  Container, Typography, Stack, Chip, Alert,
  LinearProgress, Box, ToggleButtonGroup, ToggleButton
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import { useTheme } from '@mui/material/styles';
import api from '../lib/api';

function NoRows() {
  return (
    <Box sx={{ display:'flex', alignItems:'center',
      justifyContent:'center', height:'100%' }}>
      <Typography variant="body2" color="text.disabled">
        No alerts yet. Add assets and connect Telegram to get started.
      </Typography>
    </Box>
  );
}

function useColumns() {
  const theme = useTheme();
  return [
  {
    field: 'fired_at', headerName: 'Time', width: 160,
    renderCell: p => (
      <Typography variant="caption" sx={{ fontFamily:'monospace' }}>
        {new Date(p.value).toLocaleString('en-US', {
          timeZone:'America/New_York',
          month:'short', day:'numeric',
          hour:'2-digit', minute:'2-digit',
        })} NY
      </Typography>
    ),
  },
  {
    field: 'symbol', headerName: 'Symbol', width: 120,
    renderCell: p => (
      <Typography variant="body2"
        sx={{ fontWeight:600, fontFamily:'monospace' }}>
        {p.value}
      </Typography>
    ),
  },
  { field: 'timeframe', headerName: 'TF', width: 70 },
  {
    field: 'alert_type', headerName: 'Type', width: 100,
    renderCell: p => {
      const colors = { ebp: theme.palette.primary.main, sweep: theme.palette.secondary.main, combined: theme.palette.warning.main };
      const c = colors[p.value] ?? theme.palette.text.disabled;
      return (
        <Chip label={p.value?.toUpperCase()} size="small" sx={{
          bgcolor:`${c}22`, color:c,
          border:`1px solid ${c}44`,
          borderRadius:'4px', fontWeight:700, fontSize:'0.65rem',
        }} />
      );
    },
  },
  {
    field: 'direction', headerName: 'Direction', width: 100,
    renderCell: p => (
      <Chip
        label={p.value === 'bull' ? 'BULL' : 'BEAR'}
        size="small"
        sx={{
          bgcolor: p.value === 'bull' ? `${theme.palette.success.main}20` : `${theme.palette.error.main}20`,
          color:   p.value === 'bull' ? theme.palette.success.main : theme.palette.error.main,
          border:  `1px solid ${p.value === 'bull' ? theme.palette.success.main : theme.palette.error.main}`,
          borderRadius:'4px', fontWeight:700,
        }}
      />
    ),
  },
  {
    field: 'trend_bias', headerName: 'Trend', width: 100,
    renderCell: p => (
      <Typography variant="caption" sx={{
        color: p.value==='bullish' ? theme.palette.success.main
          : p.value==='bearish' ? theme.palette.error.main : theme.palette.text.disabled,
      }}>
        {p.value}
      </Typography>
    ),
  },
  {
    field: 'candle_time', headerName: 'Candle', width: 150,
    renderCell: p => (
      <Typography variant="caption" sx={{ fontFamily:'monospace' }}>
        {p.value ? new Date(p.value).toLocaleString('en-US', {
          timeZone:'America/New_York',
          month:'short', day:'numeric',
          hour:'2-digit', minute:'2-digit',
        }) : '—'}
      </Typography>
    ),
  },
  ];
}

export default function Alerts() {
  const theme = useTheme();
  const columns = useColumns();
  const { getToken }          = useAuth();
  const [alerts, setAlerts]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [filter, setFilter]   = useState('all');

  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        const token = await getToken();
        const data  = await api.get(
          `/alerts/history?type=${filter}&limit=200`, token
        );
        setAlerts((Array.isArray(data) ? data : [])
          .map((a, i) => ({ ...a, id: a.id ?? i })));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [filter]);

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Stack direction="row" justifyContent="space-between"
        alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>Alert History</Typography>
        <ToggleButtonGroup value={filter} exclusive size="small"
          onChange={(_, v) => v && setFilter(v)}
          sx={{ '& .MuiToggleButton-root': {
            fontSize: '0.75rem', px: 1.5, py: 0.5,
            color: theme.palette.text.secondary,
            borderColor: theme.palette.divider,
            '&.Mui-selected': { color: theme.palette.primary.main, bgcolor: `${theme.palette.primary.main}15` },
          }}}>
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="ebp">EBP</ToggleButton>
          <ToggleButton value="sweep">Sweep</ToggleButton>
          <ToggleButton value="combined">⚡ Combined</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <LinearProgress sx={{ mb: 2 }} />}

      <DataGrid
        rows={alerts}
        columns={columns}
        pageSize={25}
        rowsPerPageOptions={[25, 50, 100]}
        disableRowSelectionOnClick
        autoHeight
        slots={{ noRowsOverlay: NoRows }}
        sx={{ border:'none', bgcolor:'background.default', minHeight:400 }}
      />
    </Container>
  );
}
