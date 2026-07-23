import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  Container, Typography, Stack, Paper, Button, Alert,
  Divider, RadioGroup, FormControlLabel, Radio,
  FormControl, FormLabel, CircularProgress, Box, Chip, Switch,
  LinearProgress,
} from '@mui/material';
import { useUser } from '../hooks/useUser';
import { useThemeMode } from '../context/ThemeContext';
import {
  CheckCircleOutlined,
  LinkOffOutlined,
  SendOutlined,
  DarkModeOutlined,
  LightModeOutlined,
} from '@mui/icons-material';
import api from '../lib/api';
import { useTheme } from '@mui/material/styles';

function fmtNY(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
  }) + ' NY';
}

function SourceRow({ name, data, intervalMins }) {
  const theme = useTheme();
  const now = Date.now();
  const age = data?.lastCall ? now - data.lastCall : Infinity;
  const intervalMs = intervalMins * 60 * 1000;
  const statusColor = age < intervalMs * 2  ? theme.palette.success.main
    : age < intervalMs * 4 ? theme.palette.warning.main
    : theme.palette.error.main;
  const statusLabel = age < intervalMs * 2 ? 'Live' : age < intervalMs * 4 ? 'Slow' : 'Stale';

  return (
    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ py: 0.75 }}>
      <Box sx={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        bgcolor: data ? statusColor : theme.palette.text.disabled,
      }} />
      <Typography variant="body2" sx={{ minWidth: 100, fontWeight: 500 }}>{name}</Typography>
      <Typography variant="caption" sx={{ color: statusColor, minWidth: 40 }}>
        {data ? statusLabel : 'No data'}
      </Typography>
      <Typography variant="caption" color="text.disabled">
        Last: {fmtNY(data?.lastCall)}
      </Typography>
      <Box sx={{ flexGrow: 1 }} />
      <Typography variant="caption" color="text.disabled">
        {data?.callsToday ?? 0} calls today
      </Typography>
    </Stack>
  );
}

export default function Settings() {
  const { getToken }          = useAuth();
  const { user }              = useUser();
  const { mode, toggleTheme } = useThemeMode();
  const theme                 = useTheme();

  // Data sources state
  const [dsData,       setDsData]       = useState(null);
  const [dsLoading,    setDsLoading]    = useState(true);
  const dsIntervalRef = useRef(null);

  const fetchDatasources = async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/health/datasources', token);
      setDsData(data);
    } catch {} finally {
      setDsLoading(false);
    }
  };

  useEffect(() => {
    fetchDatasources();
    dsIntervalRef.current = setInterval(fetchDatasources, 5 * 60 * 1000);
    return () => clearInterval(dsIntervalRef.current);
  }, []);

  // Telegram state
  const [tgStatus, setTgStatus]     = useState(null);
  const [linkCode, setLinkCode]     = useState('');
  const [polling, setPolling]       = useState(false);
  const [testing, setTesting]       = useState(false);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg]               = useState({ text: '', severity: 'info' });

  // Sweep state
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [sweepTFs, setSweepTFs]         = useState(['4H', '1H', 'M15']);
  const [sweepMode, setSweepMode]       = useState('aligned');
  const [savingSweep, setSavingSweep]   = useState(false);
  const [sweepSaveMsg, setSweepSaveMsg] = useState('');

  const fetchTgStatus = async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/telegram/', token);
      setTgStatus(data);
      return data;
    } catch {}
  };

  useEffect(() => {
    fetchTgStatus();
  }, []);

  useEffect(() => {
    if (!polling || !linkCode) return;
    const interval = setInterval(async () => {
      try {
        const token = await getToken();
        const data  = await api.post('/user/telegram/verify', {}, token);
        if (data?.verified) {
          setPolling(false);
          setLinkCode('');
          await fetchTgStatus();
          setMsg({ text: 'Telegram connected successfully!', severity: 'success' });
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [polling, linkCode]);

  const handleGetCode = async () => {
    setGenerating(true);
    setMsg({ text: '', severity: 'info' });
    try {
      const token = await getToken();
      const data  = await api.post('/user/telegram/initlink', {}, token);
      setLinkCode(data.code);
      setPolling(true);
    } catch (e) {
      setMsg({ text: e.message, severity: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setMsg({ text: '', severity: 'info' });
    try {
      const token = await getToken();
      await api.post('/telegram/test', {}, token);
      setMsg({ text: 'Test message sent! Check your Telegram.', severity: 'success' });
    } catch (e) {
      setMsg({ text: e.message, severity: 'error' });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Telegram? You will stop receiving alerts.')) return;
    try {
      const token = await getToken();
      await api.delete('/telegram/', token);
      setTgStatus({ connected: false });
      setMsg({ text: 'Telegram disconnected.', severity: 'info' });
    } catch (e) {
      setMsg({ text: e.message, severity: 'error' });
    }
  };

  const toggleSweepTF = (tf) => {
    setSweepTFs(prev =>
      prev.includes(tf) ? prev.filter(t => t !== tf) : [...prev, tf]
    );
  };

  const handleSaveSweepDefaults = async () => {
    setSavingSweep(true);
    setSweepSaveMsg('');
    try {
      const token  = await getToken();
      const assets = await api.get('/user/assets', token);
      await Promise.all(assets.map(asset =>
        api.patch(`/user/assets/${asset.id}/sweep`, {
          enabled:    sweepEnabled,
          timeframes: sweepTFs.join(','),
          alertMode:  sweepMode,
        }, token)
      ));
      setSweepSaveMsg('Sweep defaults saved to all assets.');
      setTimeout(() => setSweepSaveMsg(''), 3000);
    } catch (e) {
      setSweepSaveMsg('Error: ' + e.message);
    } finally {
      setSavingSweep(false);
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 3 }}>Settings</Typography>

      {/* Data Sources */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={600}>Data Sources</Typography>
          <Button size="small" variant="text" onClick={fetchDatasources} disabled={dsLoading}>
            Refresh
          </Button>
        </Stack>
        <Divider sx={{ mb: 1 }} />
        {dsLoading ? (
          <LinearProgress sx={{ my: 1 }} />
        ) : (
          <>
            <SourceRow name="Finnhub"     data={dsData?.sources?.finnhub}     intervalMins={5} />
            <SourceRow name="Yahoo"       data={dsData?.sources?.yahoo}       intervalMins={15} />
            <SourceRow name="Twelve Data" data={dsData?.sources?.twelvedata}  intervalMins={60} />
            {(dsData?.twelvedataToday ?? 0) > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    Twelve Data usage: {dsData.twelvedataToday} / {dsData.twelvedataLimit}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {Math.round((dsData.twelvedataToday / dsData.twelvedataLimit) * 100)}%
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={Math.min(100, (dsData.twelvedataToday / dsData.twelvedataLimit) * 100)}
                  color={dsData.twelvedataToday > 700 ? 'error' : dsData.twelvedataToday > 500 ? 'warning' : 'success'}
                />
              </Box>
            )}
          </>
        )}
      </Paper>

      {/* Appearance */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>Appearance</Typography>
        <Divider sx={{ mb: 2 }} />
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="body2" fontWeight={500}>Theme</Typography>
            <Typography variant="caption" color="text.secondary" display="block">
              {mode === 'dark'
                ? 'Dark mode — easy on eyes in low light'
                : 'Light mode — warm ivory, easy in bright environments'}
            </Typography>
          </Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <DarkModeOutlined sx={{ fontSize: 16, color: mode === 'dark' ? 'primary.main' : 'text.disabled' }} />
            <Switch
              checked={mode === 'light'}
              onChange={toggleTheme}
              size="small"
            />
            <LightModeOutlined sx={{ fontSize: 16, color: mode === 'light' ? 'warning.main' : 'text.disabled' }} />
          </Stack>
        </Stack>
      </Paper>

      {/* Telegram Section */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={600}>Telegram Alerts</Typography>
          {tgStatus?.connected && (
            <Chip label="Connected" size="small"
              icon={<CheckCircleOutlined />}
              sx={{ bgcolor: `${theme.palette.success.main}15`, color: theme.palette.success.main,
                border: `1px solid ${theme.palette.success.main}`, borderRadius: '4px' }} />
          )}
        </Stack>
        <Divider sx={{ mb: 2 }} />

        {tgStatus?.connected ? (
          <Stack spacing={2}>
            <Alert severity="success" icon={<CheckCircleOutlined />}>
              Connected — chat ID {tgStatus.chatIdMasked}
            </Alert>
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" size="small"
                startIcon={testing ? <CircularProgress size={14} /> : <SendOutlined />}
                onClick={handleTest} disabled={testing}>
                {testing ? 'Sending...' : 'Send Test Alert'}
              </Button>
              <Button variant="text" color="error" size="small"
                startIcon={<LinkOffOutlined />}
                onClick={handleDisconnect}>
                Disconnect
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Alert severity="info">
              Connect your Telegram to receive EBP alerts directly in your chat.
            </Alert>

            {!linkCode ? (
              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">Steps:</Typography>
                <Typography variant="body2" color="text.secondary">
                  1. Open <strong>@EbP_Tracker_bot</strong> on Telegram and tap Start
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  2. Click the button below to get your 4-digit code
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  3. Send the code to the bot
                </Typography>
                <Box sx={{ pt: 1 }}>
                  <Button variant="contained" onClick={handleGetCode}
                    disabled={generating}
                    startIcon={generating ? <CircularProgress size={14} /> : null}>
                    {generating ? 'Generating...' : 'Get Connection Code'}
                  </Button>
                </Box>
              </Stack>
            ) : (
              <Stack spacing={2}>
                <Box sx={{
                  p: 3, bgcolor: 'background.default',
                  border: `1px solid ${theme.palette.divider}`,
                  borderRadius: 2, textAlign: 'center',
                }}>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Send this code to @EbP_Tracker_bot on Telegram
                  </Typography>
                  <Typography variant="h2" sx={{
                    fontFamily: 'monospace', color: 'primary.main',
                    letterSpacing: '0.3em', my: 1,
                  }}>
                    {linkCode}
                  </Typography>
                  <Stack direction="row" alignItems="center"
                    justifyContent="center" spacing={1}>
                    <CircularProgress size={14} />
                    <Typography variant="caption" color="text.secondary">
                      Waiting for verification...
                    </Typography>
                  </Stack>
                </Box>
                <Button variant="text" size="small"
                  onClick={() => { setLinkCode(''); setPolling(false); }}>
                  Cancel
                </Button>
              </Stack>
            )}
          </Stack>
        )}

        {msg.text && (
          <Alert severity={msg.severity} sx={{ mt: 2 }}>
            {msg.text}
          </Alert>
        )}
      </Paper>

      {/* Sweep Alerts — Global Settings */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={600}>Sweep Alerts</Typography>
          <Chip
            label="GLOBAL DEFAULT"
            size="small"
            sx={{ borderRadius: '4px', fontSize: '0.65rem', bgcolor: 'background.default', color: 'text.disabled' }}
          />
        </Stack>
        <Divider sx={{ mb: 2 }} />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Default sweep settings applied to all assets. Wine subscribers can override per asset.
        </Typography>

        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Box>
              <Typography variant="body2">Enable Sweep Alerts</Typography>
              <Typography variant="caption" color="text.secondary">
                Detect liquidity sweeps — wick beyond prior high/low, close back inside
              </Typography>
            </Box>
            <Switch
              size="small"
              checked={sweepEnabled}
              onChange={e => setSweepEnabled(e.target.checked)}
            />
          </Stack>

          {sweepEnabled && (
            <>
              <Box>
                <Typography variant="body2" sx={{ mb: 1 }}>Active Timeframes</Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  {['4H', '1H', 'M30', 'M15', 'M5'].map(tf => (
                    <Chip
                      key={tf}
                      label={tf}
                      size="small"
                      onClick={() => toggleSweepTF(tf)}
                      sx={{
                        borderRadius: '4px',
                        cursor: 'pointer',
                        bgcolor: sweepTFs.includes(tf) ? `${theme.palette.primary.main}20` : 'background.default',
                        color:   sweepTFs.includes(tf) ? theme.palette.primary.main : theme.palette.text.disabled,
                        border:  `1px solid ${sweepTFs.includes(tf) ? theme.palette.primary.main : theme.palette.divider}`,
                        fontWeight: sweepTFs.includes(tf) ? 700 : 400,
                      }}
                    />
                  ))}
                </Stack>
              </Box>

              <FormControl>
                <FormLabel sx={{ color: 'text.secondary', mb: 1, fontSize: '0.875rem' }}>
                  Sweep Alert Mode
                </FormLabel>
                <RadioGroup
                  value={sweepMode}
                  onChange={e => setSweepMode(e.target.value)}
                >
                  <FormControlLabel value="aligned" control={<Radio size="small" />}
                    label={
                      <Box sx={{ py: 0.5 }}>
                        <Typography variant="body2">Trend Aligned Only</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Sweep alerts fire only when direction matches TTrades HTF bias
                        </Typography>
                      </Box>
                    }
                  />
                  <FormControlLabel value="price_action" control={<Radio size="small" />}
                    label={
                      <Box sx={{ py: 0.5 }}>
                        <Typography variant="body2">Price Action Only</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Alerts fire for any sweep regardless of HTF bias
                        </Typography>
                      </Box>
                    }
                  />
                  <FormControlLabel value="all" control={<Radio size="small" />}
                    label={
                      <Box sx={{ py: 0.5 }}>
                        <Typography variant="body2">All Sweeps</Typography>
                        <Typography variant="caption" color="text.secondary">
                          All sweeps fire with trend label shown in message
                        </Typography>
                      </Box>
                    }
                  />
                </RadioGroup>
              </FormControl>

              <Button
                variant="contained"
                size="small"
                onClick={handleSaveSweepDefaults}
                disabled={savingSweep}
                startIcon={savingSweep ? <CircularProgress size={14} /> : null}
                sx={{ alignSelf: 'flex-start' }}
              >
                {savingSweep ? 'Saving...' : 'Save Sweep Defaults'}
              </Button>

              {sweepSaveMsg && (
                <Alert severity={sweepSaveMsg.startsWith('Error') ? 'error' : 'success'} sx={{ py: 0.5 }}>
                  {sweepSaveMsg}
                </Alert>
              )}
            </>
          )}
        </Stack>
      </Paper>

      {/* Account Info */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>Account</Typography>
        <Divider sx={{ mb: 2 }} />
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">Plan</Typography>
            <Chip
              label={user?.plan?.toUpperCase() ?? 'FREE'}
              size="small"
              sx={{
                borderRadius: '4px', fontWeight: 700, fontSize: '0.7rem',
                bgcolor: { free: `${theme.palette.text.disabled}20`, coffee: `${theme.palette.warning.main}20`,
                  beer: `${theme.palette.warning.main}20`, wine: `${theme.palette.secondary.main}20` }[user?.plan] ?? 'background.default',
                color: { free: theme.palette.text.disabled, coffee: theme.palette.warning.main,
                  beer: theme.palette.warning.main, wine: theme.palette.secondary.main }[user?.plan] ?? theme.palette.text.disabled,
              }}
            />
          </Stack>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">Asset slots</Typography>
            <Typography variant="body2">{user?.asset_limit ?? 3}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">Expires</Typography>
            <Typography variant="body2">
              {user?.expires_at
                ? new Date(user.expires_at).toLocaleDateString('en-IN', {
                    day: 'numeric', month: 'short', year: 'numeric'
                  })
                : '—'}
            </Typography>
          </Stack>
        </Stack>
      </Paper>

      {/* Alert Mode Section */}
      <Paper sx={{ p: 3 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>Alert Mode</Typography>
        <Divider sx={{ mb: 2 }} />
        <FormControl>
          <FormLabel sx={{ color: 'text.secondary', mb: 1, fontSize: '0.875rem' }}>
            EBP Alert Direction
          </FormLabel>
          <RadioGroup defaultValue="aligned">
            <FormControlLabel value="aligned" control={<Radio size="small" />}
              label={
                <Box sx={{ py: 0.5 }}>
                  <Typography variant="body2">Trend Aligned Only</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Alerts fire only when EBP matches TTrades HTF bias
                  </Typography>
                </Box>
              }
            />
            <FormControlLabel value="all" control={<Radio size="small" />}
              label={
                <Box sx={{ py: 0.5 }}>
                  <Typography variant="body2">All Engulfing Bars</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Alerts fire for every EBP regardless of trend
                  </Typography>
                </Box>
              }
            />
          </RadioGroup>
        </FormControl>
      </Paper>
    </Container>
  );
}
