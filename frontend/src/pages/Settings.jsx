import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  Container, Typography, Stack, Paper, Button, Alert,
  Divider, RadioGroup, FormControlLabel, Radio,
  FormControl, FormLabel, CircularProgress, Box, Chip, Switch
} from '@mui/material';
import { useUser } from '../hooks/useUser';
import {
  CheckCircleOutlined,
  LinkOffOutlined,
  SendOutlined
} from '@mui/icons-material';
import api from '../lib/api';

export default function Settings() {
  const { getToken } = useAuth();
  const { user }     = useUser();

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
        const data  = await api.post('/telegram/verify', {}, token);
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
      const data  = await api.post('/telegram/initlink', {}, token);
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

      {/* Telegram Section */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h6">Telegram Alerts</Typography>
          {tgStatus?.connected && (
            <Chip label="Connected" size="small"
              icon={<CheckCircleOutlined />}
              sx={{ bgcolor: '#001a12', color: '#00c896',
                border: '1px solid #00c896', borderRadius: '4px' }} />
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
                  p: 3, bgcolor: '#0a0a0a',
                  border: '1px solid #2a2a2a',
                  borderRadius: 2, textAlign: 'center',
                }}>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Send this code to @EbP_Tracker_bot on Telegram
                  </Typography>
                  <Typography variant="h2" sx={{
                    fontFamily: 'monospace', color: '#4488ff',
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
          <Typography variant="h6">Sweep Alerts</Typography>
          <Chip
            label="GLOBAL DEFAULT"
            size="small"
            sx={{ borderRadius: '4px', fontSize: '0.65rem', bgcolor: '#1a1a2a', color: '#8888a8' }}
          />
        </Stack>
        <Divider sx={{ mb: 2 }} />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Default sweep settings applied to all assets. Wine subscribers can override per asset.
        </Typography>

        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box>
              <Typography variant="body2">Enable Sweep Alerts</Typography>
              <Typography variant="caption" color="text.secondary">
                Detect liquidity sweeps — wick beyond prior high/low, close back inside
              </Typography>
            </Box>
            <Switch
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
                        bgcolor: sweepTFs.includes(tf) ? '#001a33' : '#0a0a0a',
                        color:   sweepTFs.includes(tf) ? '#4488ff' : '#55556a',
                        border:  `1px solid ${sweepTFs.includes(tf) ? '#4488ff' : '#2a2a2a'}`,
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
                      <Box>
                        <Typography variant="body2">Trend Aligned Only</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Sweep alerts fire only when direction matches TTrades HTF bias
                        </Typography>
                      </Box>
                    }
                  />
                  <FormControlLabel value="price_action" control={<Radio size="small" />}
                    label={
                      <Box>
                        <Typography variant="body2">Price Action Only</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Alerts fire for any sweep regardless of HTF bias
                        </Typography>
                      </Box>
                    }
                  />
                  <FormControlLabel value="all" control={<Radio size="small" />}
                    label={
                      <Box>
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
        <Typography variant="h6" gutterBottom>Account</Typography>
        <Divider sx={{ mb: 2 }} />
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">Plan</Typography>
            <Chip
              label={user?.plan?.toUpperCase() ?? 'FREE'}
              size="small"
              sx={{
                borderRadius: '4px', fontWeight: 700, fontSize: '0.7rem',
                bgcolor: { free:'#1a1a1a', coffee:'#2a1f00',
                  beer:'#1a1200', wine:'#1a0020' }[user?.plan] ?? '#1a1a1a',
                color: { free:'#888', coffee:'#f5a623',
                  beer:'#ff8c00', wine:'#8855ff' }[user?.plan] ?? '#888',
              }}
            />
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">Asset slots</Typography>
            <Typography variant="body2">{user?.asset_limit ?? 3}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
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
        <Typography variant="h6" gutterBottom>Alert Mode</Typography>
        <Divider sx={{ mb: 2 }} />
        <FormControl>
          <FormLabel sx={{ color: 'text.secondary', mb: 1, fontSize: '0.875rem' }}>
            EBP Alert Direction
          </FormLabel>
          <RadioGroup defaultValue="aligned">
            <FormControlLabel value="aligned" control={<Radio size="small" />}
              label={
                <Box>
                  <Typography variant="body2">Trend Aligned Only</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Alerts fire only when EBP matches TTrades HTF bias
                  </Typography>
                </Box>
              }
            />
            <FormControlLabel value="all" control={<Radio size="small" />}
              label={
                <Box>
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
