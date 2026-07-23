import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import * as XLSX from 'xlsx';
import {
  Container, Typography, Stack, Chip, Alert,
  LinearProgress, Box, ToggleButtonGroup, ToggleButton,
  Select, MenuItem, FormControl, InputLabel, Button,
  TextField,
} from '@mui/material';
import { DownloadOutlined } from '@mui/icons-material';
import { DataGrid } from '@mui/x-data-grid';
import { useTheme } from '@mui/material/styles';
import api from '../lib/api';
import { useAssets } from '../hooks/useAssets';

function fmtNY(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' NY';
}

function NoRows() {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
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
        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
          {fmtNY(p.value)}
        </Typography>
      ),
    },
    {
      field: 'symbol', headerName: 'Asset', width: 120,
      renderCell: p => (
        <Typography variant="body2" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>
          {p.value}
        </Typography>
      ),
    },
    {
      field: 'alert_type', headerName: 'Type', width: 100,
      renderCell: p => {
        const colors = {
          ebp:      theme.palette.primary.main,
          sweep:    theme.palette.secondary.main,
          combined: theme.palette.warning.main,
          mss:      theme.palette.success.main,
        };
        const c = colors[p.value] ?? theme.palette.text.disabled;
        return (
          <Chip label={p.value?.toUpperCase()} size="small" sx={{
            bgcolor: `${c}22`, color: c,
            border: `1px solid ${c}44`,
            borderRadius: '4px', fontWeight: 700, fontSize: '0.65rem',
          }} />
        );
      },
    },
    {
      field: 'direction', headerName: 'Direction', width: 110,
      renderCell: p => (
        <Chip
          label={p.value === 'bullish' ? '🟢 BULLISH' : '🔴 BEARISH'}
          size="small"
          sx={{
            bgcolor: p.value === 'bullish' ? `${theme.palette.success.main}20` : `${theme.palette.error.main}20`,
            color:   p.value === 'bullish' ? theme.palette.success.main : theme.palette.error.main,
            border:  `1px solid ${p.value === 'bullish' ? theme.palette.success.main : theme.palette.error.main}`,
            borderRadius: '4px', fontWeight: 700,
          }}
        />
      ),
    },
    { field: 'timeframe', headerName: 'TF', width: 70 },
    {
      field: 'trend_bias', headerName: 'Bias', width: 100,
      renderCell: p => (
        <Typography variant="caption" sx={{
          color: p.value === 'bullish' ? theme.palette.success.main
            : p.value === 'bearish' ? theme.palette.error.main : theme.palette.text.disabled,
        }}>
          {p.value}
        </Typography>
      ),
    },
    {
      field: 'candle_time', headerName: 'Candle', width: 150,
      renderCell: p => (
        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
          {p.value ? fmtNY(p.value) : '—'}
        </Typography>
      ),
    },
    {
      field: 'details', headerName: 'Detail', width: 180, flex: 1,
      renderCell: p => {
        if (!p.value) return null;
        try {
          const d = JSON.parse(p.value);
          const parts = [];
          if (d.swept_level)  parts.push(`Swept: ${Number(d.swept_level).toFixed(5)}`);
          if (d.mss_level)    parts.push(`MSS: ${Number(d.mss_level).toFixed(5)}`);
          if (d.chain_step)   parts.push(`Step ${d.chain_step}`);
          return (
            <Typography variant="caption" color="text.secondary">
              {parts.join(' · ') || ''}
            </Typography>
          );
        } catch { return null; }
      },
    },
  ];
}

export default function Alerts() {
  const theme     = useTheme();
  const columns   = useColumns();
  const { getToken }        = useAuth();
  const { assets }          = useAssets();
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError]   = useState(null);

  // filters
  const [filter,    setFilter]    = useState('all');
  const [assetId,   setAssetId]   = useState('all');
  const [direction, setDirection] = useState('all');
  const [days,      setDays]      = useState(2);

  // export date range
  const [exportFrom, setExportFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [exportTo, setExportTo] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        const token = await getToken();
        const params = new URLSearchParams({ limit: '200', days: String(days) });
        if (filter !== 'all') params.set('type', filter);
        if (assetId !== 'all') params.set('assetId', assetId);
        const data = await api.get(`/alerts/history?${params}`, token);
        let rows = (Array.isArray(data) ? data : []).map((a, i) => ({ ...a, id: a.id ?? i }));
        if (direction !== 'all') rows = rows.filter(r => r.direction === direction);
        setAlerts(rows);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [filter, assetId, direction, days]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const token = await getToken();
      const from  = new Date(exportFrom).getTime();
      const to    = new Date(exportTo).getTime() + 86400000;
      const params = new URLSearchParams({ from: String(from), to: String(to) });
      if (assetId !== 'all') params.set('assetId', assetId);
      const data = await api.get(`/alerts/export?${params}`, token);
      const rows = (Array.isArray(data) ? data : []).map(r => ({
        Time:      fmtNY(r.fired_at),
        Asset:     r.symbol,
        Type:      r.alert_type?.toUpperCase(),
        Direction: r.direction,
        Timeframe: r.timeframe,
        Bias:      r.trend_bias,
        Candle:    fmtNY(r.candle_time),
        Detail:    r.details ? (() => {
          try {
            const d = JSON.parse(r.details);
            const parts = [];
            if (d.swept_level) parts.push(`Swept: ${d.swept_level}`);
            if (d.mss_level)   parts.push(`MSS: ${d.mss_level}`);
            return parts.join(', ');
          } catch { return ''; }
        })() : '',
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Alerts');
      XLSX.writeFile(wb, `ebp-alerts-${Date.now()}.xlsx`);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>Alert History</Typography>
        <Stack direction="row" alignItems="center" spacing={1}>
          <TextField
            type="date" size="small" value={exportFrom}
            onChange={e => setExportFrom(e.target.value)}
            sx={{ width: 140 }}
            InputLabelProps={{ shrink: true }}
            label="From"
          />
          <TextField
            type="date" size="small" value={exportTo}
            onChange={e => setExportTo(e.target.value)}
            sx={{ width: 140 }}
            InputLabelProps={{ shrink: true }}
            label="To"
          />
          <Button
            variant="outlined" size="small"
            startIcon={<DownloadOutlined />}
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting...' : 'Export Excel'}
          </Button>
        </Stack>
      </Stack>

      {/* Filters row */}
      <Stack direction="row" flexWrap="wrap" gap={1.5} sx={{ mb: 2 }} alignItems="center">
        {/* Type filter */}
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
          <ToggleButton value="combined">Combined</ToggleButton>
          <ToggleButton value="mss">MSS</ToggleButton>
        </ToggleButtonGroup>

        {/* Asset filter */}
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>Asset</InputLabel>
          <Select value={assetId} label="Asset" onChange={e => setAssetId(e.target.value)}>
            <MenuItem value="all">All assets</MenuItem>
            {(assets ?? []).map(a => (
              <MenuItem key={a.id} value={a.id}>{a.symbol}</MenuItem>
            ))}
          </Select>
        </FormControl>

        {/* Direction filter */}
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel>Direction</InputLabel>
          <Select value={direction} label="Direction" onChange={e => setDirection(e.target.value)}>
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="bullish">Bullish</MenuItem>
            <MenuItem value="bearish">Bearish</MenuItem>
          </Select>
        </FormControl>

        {/* Days filter */}
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Period</InputLabel>
          <Select value={days} label="Period" onChange={e => setDays(e.target.value)}>
            <MenuItem value={1}>Today</MenuItem>
            <MenuItem value={2}>Last 2 days</MenuItem>
            <MenuItem value={7}>Last 7 days</MenuItem>
            <MenuItem value={30}>Last 30 days</MenuItem>
          </Select>
        </FormControl>
      </Stack>

      {error   && <Alert severity="error"   sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <LinearProgress sx={{ mb: 2 }} />}

      <DataGrid
        rows={alerts}
        columns={columns}
        pageSize={25}
        rowsPerPageOptions={[25, 50, 100]}
        disableRowSelectionOnClick
        autoHeight
        slots={{ noRowsOverlay: NoRows }}
        sx={{ border: 'none', bgcolor: 'background.default', minHeight: 400 }}
      />
    </Container>
  );
}
