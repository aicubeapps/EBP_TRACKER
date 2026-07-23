import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import {
  Container, Typography, Stack, Paper, Button, Alert,
  Divider, CircularProgress, Box, Chip, Switch, LinearProgress,
  RadioGroup, FormControlLabel, Radio,
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

const TIER_EMOJI = { free: '', chai: '🍵', coffee: '☕', beer: '🍺', wine: '🍷', whiskey: '🥃' };
const TIERS = ['coffee', 'beer', 'wine'];

function daysRemaining(expiresAt) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(ts) {
  if (!ts) return 'Never';
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }) + ' NY';
}

function statusDot(lastCall) {
  if (!lastCall) return '🔴';
  const age = Date.now() - lastCall;
  if (age < 30 * 60 * 1000) return '🟢';
  if (age < 60 * 60 * 1000) return '🟡';
  return '🔴';
}

export default function Settings() {
  const { getToken }          = useAuth();
  const { user }              = useUser();
  const navigate               = useNavigate();
  const { mode, toggleTheme } = useThemeMode();
  const theme                 = useTheme();

  const [selectedTier, setSelectedTier] = useState('');

  // Data sources state
  const [dsHealth,  setDsHealth]  = useState(null);
  const [dsLoading, setDsLoading] = useState(true);

  const fetchDsHealth = async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/health/datasources', token);
      setDsHealth(data);
    } catch {}
    setDsLoading(false);
  };

  useEffect(() => {
    fetchDsHealth();
    const iv = setInterval(fetchDsHealth, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // Telegram state
  const [tgStatus, setTgStatus]     = useState(null);
  const [linkCode, setLinkCode]     = useState('');
  const [polling, setPolling]       = useState(false);
  const [testing, setTesting]       = useState(false);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg]               = useState({ text: '', severity: 'info' });

  const fetchTgStatus = async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/user/telegram', token);
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
      await api.post('/user/telegram/test', {}, token);
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
      await api.delete('/user/telegram', token);
      setTgStatus({ connected: false });
      setMsg({ text: 'Telegram disconnected.', severity: 'info' });
    } catch (e) {
      setMsg({ text: e.message, severity: 'error' });
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 3 }}>Settings</Typography>

      {/* Account */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>Account</Typography>
        <Divider sx={{ mb: 2 }} />
        <Stack spacing={1} sx={{ mb: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">Joined On</Typography>
            <Typography variant="body2">{fmtDate(user?.created_at)}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">Current Plan</Typography>
            <Chip
              label={`${TIER_EMOJI[user?.plan] ?? ''} ${user?.plan?.toUpperCase() ?? 'FREE'}`}
              size="small"
              sx={{ borderRadius: '4px', fontWeight: 700, fontSize: '0.7rem' }}
            />
          </Stack>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">Days Remaining</Typography>
            <Typography variant="body2">{daysRemaining(user?.expires_at)} days</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">Asset slots</Typography>
            <Typography variant="body2">{user?.asset_limit ?? 3}</Typography>
          </Stack>
        </Stack>

        <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>Upgrade</Typography>
        <RadioGroup row value={selectedTier} onChange={e => setSelectedTier(e.target.value)}>
          {TIERS.map(t => (
            <FormControlLabel
              key={t}
              value={t}
              control={<Radio size="small" />}
              label={`${TIER_EMOJI[t]} ${t.charAt(0).toUpperCase() + t.slice(1)}`}
              disabled={t === user?.plan}
            />
          ))}
        </RadioGroup>
        {selectedTier && selectedTier !== user?.plan && (
          <Button variant="contained" size="small" sx={{ mt: 1 }} onClick={() => navigate('/upgrade')}>
            Upgrade to {selectedTier.charAt(0).toUpperCase() + selectedTier.slice(1)}
          </Button>
        )}
      </Paper>

      {/* Data Sources */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={600}>Data Sources</Typography>
          <Button size="small" variant="text" onClick={fetchDsHealth} disabled={dsLoading}
            sx={{ fontSize: '0.7rem' }}>
            Refresh
          </Button>
        </Stack>
        <Divider sx={{ mb: 2 }} />

        {dsLoading ? (
          <CircularProgress size={20} />
        ) : !dsHealth ? (
          <Typography variant="body2" color="text.secondary">Could not load data source status.</Typography>
        ) : (
          <Stack spacing={1}>
            {Object.entries(dsHealth.sources ?? {}).map(([name, info]) => (
              <Stack key={name} direction="row" alignItems="center" spacing={1.5}>
                <Typography sx={{ width: 90, textTransform: 'capitalize', fontSize: '0.875rem' }}>
                  {name}
                </Typography>
                <Typography sx={{ fontSize: '1rem', lineHeight: 1 }}>{statusDot(info.lastCall)}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                  Last: {fmtTime(info.lastCall)}
                </Typography>
                {name === 'twelvedata' && (
                  <Typography variant="caption" color="text.disabled">
                    {dsHealth.twelvedataToday}/{dsHealth.twelvedataLimit ?? 800} today
                  </Typography>
                )}
              </Stack>
            ))}
            {(dsHealth.twelvedataToday ?? 0) > 0 && (
              <Box sx={{ pt: 0.5 }}>
                <LinearProgress
                  variant="determinate"
                  value={Math.min(((dsHealth.twelvedataToday ?? 0) / (dsHealth.twelvedataLimit ?? 800)) * 100, 100)}
                  color={dsHealth.twelvedataToday > 700 ? 'error' : dsHealth.twelvedataToday > 500 ? 'warning' : 'success'}
                  sx={{ height: 5, borderRadius: 3 }}
                />
                <Typography variant="caption" color="text.secondary">
                  Twelve Data daily limit: {dsHealth.twelvedataToday}/{dsHealth.twelvedataLimit ?? 800}
                </Typography>
              </Box>
            )}
          </Stack>
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

      {/* Telegram */}
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

    </Container>
  );
}
