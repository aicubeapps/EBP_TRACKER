import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import {
  Card, CardContent, Stack, Typography, Chip, Box,
  IconButton, Button, Select, MenuItem, Collapse,
  FormControlLabel, Checkbox, Divider, Tooltip,
} from '@mui/material';
import { CloseOutlined, AddOutlined } from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import api from '../lib/api';
import { BIAS_SOURCE_FRONTEND, EBP_TFS, SWEEP_TFS } from '../lib/constants';

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

const ALERT_MODES = [
  { value: 'aligned',      label: 'Aligned' },
  { value: 'price_action', label: 'Price Action' },
  { value: 'all',          label: 'All' },
];

function ConfigRow({ config, biasCache, biasSrc, onDelete, onUpdate }) {
  const theme   = useTheme();
  const biasTF  = biasSrc?.[config.timeframe] ?? null;
  const biasData = biasTF ? biasCache?.[biasTF] : null;
  const bias    = biasData?.bias ?? 'neutral';
  const biasColor = bias === 'bullish' ? theme.palette.success.main
    : bias === 'bearish' ? theme.palette.error.main
    : theme.palette.text.disabled;

  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ py: 0.5 }}>
      <Chip
        label={config.timeframe}
        size="small"
        sx={{
          borderRadius: '4px', fontWeight: 700, minWidth: 42,
          bgcolor: `${theme.palette.primary.main}15`,
          color: theme.palette.primary.main,
          border: `1px solid ${theme.palette.primary.main}44`,
        }}
      />
      <Select
        value={config.alert_mode}
        size="small"
        onChange={e => onUpdate(config.id, { alert_mode: e.target.value })}
        sx={{ fontSize: '0.7rem', height: 24, '.MuiSelect-select': { py: 0, px: 1 } }}
      >
        {ALERT_MODES.map(m => (
          <MenuItem key={m.value} value={m.value} sx={{ fontSize: '0.75rem' }}>
            {m.label}
          </MenuItem>
        ))}
      </Select>
      {biasTF && (
        <Typography variant="caption" sx={{ color: biasColor, minWidth: 90, flexShrink: 0 }}>
          Bias: {capitalise(bias)}({biasTF})
        </Typography>
      )}
      <Box sx={{ flexGrow: 1 }} />
      <IconButton size="small" onClick={() => onDelete(config.id)} sx={{ p: 0.25 }}>
        <CloseOutlined sx={{ fontSize: 14, color: 'text.disabled' }} />
      </IconButton>
    </Stack>
  );
}

function SectionPanel({ label, checked, onToggle, children, addLabel, onAdd }) {
  return (
    <Box sx={{ mt: 1 }}>
      <FormControlLabel
        control={<Checkbox size="small" checked={checked} onChange={e => onToggle(e.target.checked)} />}
        label={<Typography variant="body2" fontWeight={600}>{label}</Typography>}
        sx={{ m: 0 }}
      />
      <Collapse in={checked}>
        <Box sx={{
          mt: 0.5, p: 1,
          border: theme => `1px solid ${theme.palette.divider}`,
          borderRadius: 1,
          bgcolor: 'background.default',
        }}>
          {children}
          <Button
            size="small"
            startIcon={<AddOutlined sx={{ fontSize: 14 }} />}
            onClick={onAdd}
            sx={{ mt: 0.5, fontSize: '0.7rem', py: 0.25 }}
          >
            {addLabel}
          </Button>
        </Box>
      </Collapse>
    </Box>
  );
}

export default function AssetCard({ asset, onRemove }) {
  const { getToken } = useAuth();
  const navigate     = useNavigate();
  const theme        = useTheme();

  const [ebpOpen,    setEbpOpen]    = useState(false);
  const [sweepOpen,  setSweepOpen]  = useState(false);
  const [ebpConfigs, setEbpConfigs] = useState([]);
  const [swpConfigs, setSwpConfigs] = useState([]);
  const [lastAlert,  setLastAlert]  = useState(null);
  const [biasCache,  setBiasCache]  = useState({});

  const fetchAll = useCallback(async () => {
    const token = await getToken();
    const [ebp, swp, hist, bias] = await Promise.allSettled([
      api.get(`/user/ebp-configs/${asset.id}`, token),
      api.get(`/user/sweep-configs/${asset.id}`, token),
      api.get(`/alerts/history?assetId=${asset.id}&days=2&limit=1`, token),
      api.get(`/user/bias/${encodeURIComponent(asset.symbol)}`, token),
    ]);
    if (ebp.status === 'fulfilled')  setEbpConfigs(Array.isArray(ebp.value) ? ebp.value : []);
    if (swp.status === 'fulfilled')  setSwpConfigs(Array.isArray(swp.value) ? swp.value : []);
    if (hist.status === 'fulfilled' && Array.isArray(hist.value) && hist.value.length > 0)
      setLastAlert(hist.value[0]);
    if (bias.status === 'fulfilled') setBiasCache(bias.value ?? {});
  }, [asset.id, asset.symbol, getToken]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 60000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const addEbpConfig = async () => {
    const tf    = EBP_TFS.find(t => !ebpConfigs.some(c => c.timeframe === t)) ?? EBP_TFS[0];
    const token = await getToken();
    const res   = await api.post(`/user/ebp-configs/${asset.id}`, { timeframe: tf, alert_mode: 'aligned' }, token);
    setEbpConfigs(prev => [...prev, { id: res.id, timeframe: tf, alert_mode: 'aligned', enabled: 1 }]);
  };

  const deleteEbpConfig = async (id) => {
    const token = await getToken();
    await api.delete(`/user/ebp-configs/${id}`, token);
    setEbpConfigs(prev => prev.filter(c => c.id !== id));
  };

  const updateEbpConfig = async (id, patch) => {
    const token = await getToken();
    await api.patch(`/user/ebp-configs/${id}`, patch, token);
    setEbpConfigs(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  };

  const addSwpConfig = async () => {
    const tf    = SWEEP_TFS.find(t => !swpConfigs.some(c => c.timeframe === t)) ?? SWEEP_TFS[0];
    const token = await getToken();
    const res   = await api.post(`/user/sweep-configs/${asset.id}`, { timeframe: tf, alert_mode: 'aligned' }, token);
    setSwpConfigs(prev => [...prev, { id: res.id, timeframe: tf, alert_mode: 'aligned', enabled: 1 }]);
  };

  const deleteSwpConfig = async (id) => {
    const token = await getToken();
    await api.delete(`/user/sweep-configs/${id}`, token);
    setSwpConfigs(prev => prev.filter(c => c.id !== id));
  };

  const updateSwpConfig = async (id, patch) => {
    const token = await getToken();
    await api.patch(`/user/sweep-configs/${id}`, patch, token);
    setSwpConfigs(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  };

  const typeColor = {
    forex:     theme.palette.primary.main,
    commodity: theme.palette.warning.main,
    index:     theme.palette.secondary.main,
    nse_asset: theme.palette.success.main,
    crypto:    theme.palette.warning.main,
  }[asset.asset_type] ?? theme.palette.primary.main;

  return (
    <Card sx={{ mb: 2, border: `1px solid ${theme.palette.divider}` }}>
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>

        {/* Header row */}
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between">
          <Box>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="h6" fontWeight={700} sx={{ fontFamily: 'monospace', fontSize: '1rem' }}>
                {asset.symbol}
              </Typography>
              <Chip
                label={asset.asset_type?.toUpperCase().replace('_', ' ')}
                size="small"
                sx={{
                  borderRadius: '3px', fontSize: '0.6rem', fontWeight: 600, height: 16,
                  bgcolor: `${typeColor}18`, color: typeColor,
                  border: `1px solid ${typeColor}33`,
                  '& .MuiChip-label': { px: 0.75 },
                }}
              />
            </Stack>
            {lastAlert && (
              <Tooltip title="View all alerts">
                <Typography
                  variant="caption"
                  sx={{ color: 'text.disabled', cursor: 'pointer', mt: 0.25, display: 'block' }}
                  onClick={() => navigate('/alerts')}
                >
                  Last: {lastAlert.direction.toUpperCase()} {lastAlert.alert_type.toUpperCase()} {lastAlert.timeframe} — {fmtNY(lastAlert.fired_at)}
                </Typography>
              </Tooltip>
            )}
          </Box>
          <Button
            size="small" color="error" variant="text"
            onClick={() => onRemove(asset.id)}
            sx={{ minWidth: 0, px: 0.5, fontSize: '0.7rem', opacity: 0.6, flexShrink: 0 }}
          >
            Remove
          </Button>
        </Stack>

        <Divider sx={{ my: 1 }} />

        {/* EBP Alerts section */}
        <SectionPanel
          label="EBP Alerts"
          checked={ebpOpen}
          onToggle={setEbpOpen}
          addLabel="Add EBP Alert"
          onAdd={addEbpConfig}
        >
          {ebpConfigs.length === 0 && (
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.5 }}>
              No EBP alert timeframes configured.
            </Typography>
          )}
          {ebpConfigs.map(cfg => (
            <ConfigRow
              key={cfg.id}
              config={cfg}
              biasCache={biasCache}
              biasSrc={BIAS_SOURCE_FRONTEND.ebp}
              onDelete={deleteEbpConfig}
              onUpdate={updateEbpConfig}
            />
          ))}
        </SectionPanel>

        {/* Sweep Alerts section */}
        <SectionPanel
          label="Sweep Alerts"
          checked={sweepOpen}
          onToggle={setSweepOpen}
          addLabel="Add Sweep Alert"
          onAdd={addSwpConfig}
        >
          {swpConfigs.length === 0 && (
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.5 }}>
              No sweep alert timeframes configured.
            </Typography>
          )}
          {swpConfigs.map(cfg => (
            <ConfigRow
              key={cfg.id}
              config={cfg}
              biasCache={biasCache}
              biasSrc={BIAS_SOURCE_FRONTEND.sweep}
              onDelete={deleteSwpConfig}
              onUpdate={updateSwpConfig}
            />
          ))}
        </SectionPanel>

      </CardContent>
    </Card>
  );
}
