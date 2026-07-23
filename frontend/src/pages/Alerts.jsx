import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import * as XLSX from 'xlsx';
import {
  Container, Typography, Stack, Chip, Alert,
  LinearProgress, Box, ToggleButtonGroup, ToggleButton,
  Select, MenuItem, FormControl, InputLabel, Button,
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

function capitalise(str) {
  if (!str) return '—';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatBiasAlignment(row) {
  if (!row.trend_bias) return '—';
  const aligned = row.direction === row.trend_bias;
  return `${capitalise(row.trend_bias)}, ${aligned ? 'Aligned' : 'Not Aligned'}`;
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
      field: 'fired_at', headerName: 'Time Stamp', width: 170,
      renderCell: p => (
        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
          {fmtNY(p.value)}
        </Typography>
      ),
    },
    {
      field: 'symbol', headerName: 'Asset', width: 110,
      renderCell: p => (
        <Typography variant="body2" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>
          {p.value}
        </Typography>
      ),
    },
    {
      field: 'alert_type', headerName: 'Alert Type', width: 110,
      renderCell: p => {
        const colors = {
          ebp:      theme.palette.primary.main,
          sweep:    theme.palette.secondary.main,
          mss:      theme.palette.text.secondary,
          t1:       theme.palette.warning.main,
          t2:       theme.palette.warning.main,
          t3:       theme.palette.success.main,
          t4:       theme.palette.warning.main,
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
      field: 'direction', headerName: 'Direction', width: 120,
      renderCell: p => (
        <Chip
          label={p.value === 'bullish' ? '🟢 Bullish' : '🔴 Bearish'}
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
      field: 'bias_alignment', headerName: 'Bias & Alignment', width: 200, flex: 1,
      valueGetter: (_, row) => formatBiasAlignment(row),
      renderCell: p => {
        const aligned = p.row.direction === p.row.trend_bias;
        return (
          <Typography variant="body2" sx={{
            color: !p.row.trend_bias ? theme.palette.text.disabled
              : aligned ? theme.palette.success.main : theme.palette.warning.main,
          }}>
            {p.value}
          </Typography>
        );
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

  // download range
  const [downloadRange, setDownloadRange] = useState('7');

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
      const url   = downloadRange === 'all' ? '/alerts/export' : `/alerts/export?days=${downloadRange}`;
      const data  = await api.get(url, token);
      const rows  = (Array.isArray(data) ? data : []).map(r => ({
        'Time (NY)':         fmtNY(r.fired_at),
        'Asset':              r.symbol,
        'Alert Type':         r.alert_type?.toUpperCase(),
        'Direction':          capitalise(r.direction),
        'Timeframe':          r.timeframe,
        'Bias & Alignment':   formatBiasAlignment(r),
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Alerts');
      XLSX.writeFile(wb, `forex-alerts-${Date.now()}.xlsx`);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1.5}>
        <Typography variant="h5" fontWeight={700}>Alert History</Typography>
        <Stack direction="row" alignItems="center" spacing={1}>
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Download range</InputLabel>
            <Select value={downloadRange} label="Download range" onChange={e => setDownloadRange(e.target.value)}>
              <MenuItem value="7">Last week</MenuItem>
              <MenuItem value="30">Last month</MenuItem>
              <MenuItem value="all">All Alert History</MenuItem>
            </Select>
          </FormControl>
          <Button
            variant="outlined" size="small"
            startIcon={<DownloadOutlined />}
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting...' : 'Download'}
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
          <ToggleButton value="mss">MSS</ToggleButton>
          <ToggleButton value="t3">T3</ToggleButton>
        </ToggleButtonGroup>

        {/* Asset filter */}
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>Assets</InputLabel>
          <Select value={assetId} label="Assets" onChange={e => setAssetId(e.target.value)}>
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
