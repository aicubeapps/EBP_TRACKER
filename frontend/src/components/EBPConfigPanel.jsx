import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Box, Stack, Select, MenuItem, IconButton, Button, Typography, CircularProgress } from '@mui/material';
import { CloseOutlined, AddOutlined } from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import api from '../lib/api';
import { EBP_TFS, BIAS_SOURCE_FRONTEND } from '../lib/constants';

const ALERT_MODES = [
  { value: 'aligned',      label: 'Aligned' },
  { value: 'price_action', label: 'Price Action' },
  { value: 'all',          label: 'All' },
];

function capitalise(str) {
  if (!str) return '—';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export default function EBPConfigPanel({ assetId, biasCache }) {
  const { getToken } = useAuth();
  const theme = useTheme();
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchConfigs = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get(`/user/ebp-configs/${assetId}`, token);
    setConfigs(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [assetId, getToken]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  async function addConfig() {
    const tf    = EBP_TFS.find(t => !configs.some(c => c.timeframe === t)) ?? EBP_TFS[0];
    const token = await getToken();
    const res   = await api.post(`/user/ebp-configs/${assetId}`, { timeframe: tf, alert_mode: 'aligned' }, token);
    setConfigs(prev => [...prev, { id: res.id, timeframe: tf, alert_mode: 'aligned', enabled: 1 }]);
  }

  async function updateConfig(id, field, value) {
    const token = await getToken();
    await api.patch(`/user/ebp-configs/${id}`, { [field]: value }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  }

  async function deleteConfig(id) {
    const token = await getToken();
    await api.delete(`/user/ebp-configs/${id}`, token);
    setConfigs(prev => prev.filter(c => c.id !== id));
  }

  if (loading) return <CircularProgress size={16} sx={{ ml: 3, mt: 1 }} />;

  return (
    <Box sx={{ ml: 3, mt: 1 }}>
      {configs.length === 0 && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.5 }}>
          No EBP alert timeframes configured.
        </Typography>
      )}
      {configs.map(cfg => {
        const biasTF   = BIAS_SOURCE_FRONTEND.ebp[cfg.timeframe] ?? null;
        const biasData = biasTF ? biasCache?.[biasTF] : null;
        const bias     = biasData?.bias ?? 'neutral';
        const biasColor = bias === 'bullish' ? theme.palette.success.main
          : bias === 'bearish' ? theme.palette.error.main
          : theme.palette.text.disabled;

        return (
          <Stack key={cfg.id} direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <Select size="small" value={cfg.timeframe}
              onChange={e => updateConfig(cfg.id, 'timeframe', e.target.value)}
              sx={{ minWidth: 72, fontSize: '0.8rem' }}>
              {EBP_TFS.map(tf => <MenuItem key={tf} value={tf}>{tf}</MenuItem>)}
            </Select>
            <Select size="small" value={cfg.alert_mode}
              onChange={e => updateConfig(cfg.id, 'alert_mode', e.target.value)}
              sx={{ minWidth: 100, fontSize: '0.8rem' }}>
              {ALERT_MODES.map(m => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
            </Select>
            {biasTF && (
              <Typography variant="caption" sx={{ color: biasColor, minWidth: 90, flexShrink: 0 }}>
                Bias: {capitalise(bias)} ({biasTF})
              </Typography>
            )}
            <Box sx={{ flexGrow: 1 }} />
            <IconButton size="small" onClick={() => deleteConfig(cfg.id)}>
              <CloseOutlined sx={{ fontSize: 14, color: 'text.disabled' }} />
            </IconButton>
          </Stack>
        );
      })}
      <Button size="small" startIcon={<AddOutlined sx={{ fontSize: 14 }} />} onClick={addConfig}>
        Add EBP Alert
      </Button>
    </Box>
  );
}
