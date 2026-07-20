import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  Container, Typography, Stack, Paper, Button, Alert,
  Divider, RadioGroup, FormControlLabel, Radio,
  FormControl, FormLabel, CircularProgress, Box, Chip
} from '@mui/material';
import {
  CheckCircleOutlined,
  LinkOffOutlined,
  SendOutlined
} from '@mui/icons-material';
import api from '../lib/api';

export default function Settings() {
  const { getToken }                = useAuth();
  const [tgStatus, setTgStatus]     = useState(null);
  const [linkCode, setLinkCode]     = useState('');
  const [polling, setPolling]       = useState(false);
  const [testing, setTesting]       = useState(false);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg]               = useState({ text: '', severity: 'info' });

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

  // Poll for verification every 3 seconds after code is shown
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
