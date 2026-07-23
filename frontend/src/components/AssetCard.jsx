import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import {
  Card, CardContent, Stack, Typography, Chip, Box,
  Button, FormControlLabel, Checkbox, Divider, Tooltip,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import api from '../lib/api';
import EBPConfigPanel from './EBPConfigPanel';
import SweepConfigPanel from './SweepConfigPanel';
import AIAlertsPanel from './AIAlertsPanel';
import BiasOverridePanel from './BiasOverridePanel';

function fmtNY(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' NY';
}

export default function AssetCard({ asset, tier, onRemove }) {
  const { getToken } = useAuth();
  const navigate     = useNavigate();
  const theme        = useTheme();

  const [ebpEnabled,   setEbpEnabled]   = useState(false);
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [aiEnabled,    setAiEnabled]    = useState(false);
  const [showBiasOverride, setShowBiasOverride] = useState(false);
  const [biasOverrides, setBiasOverrides] = useState(() => {
    try { return JSON.parse(asset.bias_overrides || '{}'); } catch { return {}; }
  });
  const [lastAlert, setLastAlert] = useState(null);
  const [biasCache, setBiasCache] = useState({});

  const fetchSummary = useCallback(async () => {
    const token = await getToken();
    const [ebp, swp, tmpl, hist, bias] = await Promise.allSettled([
      api.get(`/user/ebp-configs/${asset.id}`, token),
      api.get(`/user/sweep-configs/${asset.id}`, token),
      api.get(`/user/templates/${asset.id}`, token),
      api.get(`/alerts/history?assetId=${asset.id}&days=2&limit=1`, token),
      api.get(`/user/bias/${encodeURIComponent(asset.symbol)}`, token),
    ]);
    if (ebp.status === 'fulfilled')  setEbpEnabled(Array.isArray(ebp.value) && ebp.value.length > 0);
    if (swp.status === 'fulfilled')  setSweepEnabled(Array.isArray(swp.value) && swp.value.length > 0);
    if (tmpl.status === 'fulfilled') setAiEnabled(Array.isArray(tmpl.value) && tmpl.value.some(t => t.enabled));
    if (hist.status === 'fulfilled' && Array.isArray(hist.value) && hist.value.length > 0)
      setLastAlert(hist.value[0]);
    if (bias.status === 'fulfilled') setBiasCache(bias.value ?? {});
  }, [asset.id, asset.symbol, getToken]);

  useEffect(() => {
    fetchSummary();
    const id = setInterval(fetchSummary, 60000);
    return () => clearInterval(id);
  }, [fetchSummary]);

  const handleOverrideChange = async (tf, value) => {
    const updated = { ...biasOverrides, [tf]: value };
    setBiasOverrides(updated);
    const token = await getToken();
    await api.patch(`/user/assets/${asset.id}/bias-overrides`, { bias_overrides: updated }, token);
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

        {/* EBP Alerts */}
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <FormControlLabel
            control={<Checkbox checked={ebpEnabled} onChange={e => setEbpEnabled(e.target.checked)} />}
            label={<Typography variant="body2" fontWeight={600}>EBP Alerts</Typography>}
          />
          <Button size="small" onClick={() => setShowBiasOverride(o => !o)} sx={{ fontSize: '0.7rem' }}>
            {showBiasOverride ? 'Hide' : 'Override'} Bias
          </Button>
        </Stack>
        {showBiasOverride && (
          <BiasOverridePanel overrides={biasOverrides} onChange={handleOverrideChange} />
        )}
        {ebpEnabled && <EBPConfigPanel assetId={asset.id} biasCache={biasCache} />}

        {/* Sweep Alerts */}
        <FormControlLabel
          control={<Checkbox checked={sweepEnabled} onChange={e => setSweepEnabled(e.target.checked)} />}
          label={<Typography variant="body2" fontWeight={600}>Sweep Alerts</Typography>}
        />
        {sweepEnabled && <SweepConfigPanel assetId={asset.id} biasCache={biasCache} />}

        {/* AI Alerts */}
        <FormControlLabel
          control={<Checkbox checked={aiEnabled} onChange={e => setAiEnabled(e.target.checked)} />}
          label={<Typography variant="body2" fontWeight={600}>AI Alerts</Typography>}
        />
        {aiEnabled && <AIAlertsPanel assetId={asset.id} tier={tier} />}

      </CardContent>
    </Card>
  );
}
