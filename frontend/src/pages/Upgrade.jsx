import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  Container, Typography, Stack, Card, CardContent,
  Button, Chip, Divider, TextField, Alert,
  Box, Grid, CircularProgress, Paper
} from '@mui/material';
import {
  CheckCircleOutlined,
  ContentCopyOutlined,
} from '@mui/icons-material';
import api from '../lib/api';
import { useUser } from '../hooks/useUser';

const TIERS = [
  {
    id: 'coffee',
    emoji: '☕',
    name: 'Coffee',
    price: 99,
    assets: 5,
    features: [
      '5 asset slots',
      'All 5 timeframes',
      'Telegram alerts',
      'Alert history',
      'Valid 30 days',
    ],
  },
  {
    id: 'beer',
    emoji: '🍺',
    name: 'Beer',
    price: 249,
    assets: 8,
    recommended: true,
    features: [
      '8 asset slots',
      'All 5 timeframes',
      'Telegram alerts',
      'Alert history',
      'Valid 30 days',
    ],
  },
  {
    id: 'wine',
    emoji: '🍷',
    name: 'Wine',
    price: 499,
    assets: 13,
    features: [
      '13 asset slots',
      'All 5 timeframes',
      'Custom TF pairing',
      'Telegram alerts',
      'Priority support',
      'Valid 30 days',
    ],
  },
];

const UPI_ID = '8087778493@ybl';

export default function Upgrade() {
  const { getToken }                      = useAuth();
  const { user }                          = useUser();
  const [selectedTier, setSelectedTier]   = useState(null);
  const [upiRef, setUpiRef]               = useState('');
  const [submitting, setSubmitting]       = useState(false);
  const [paymentStatus, setPaymentStatus] = useState(null);
  const [msg, setMsg]                     = useState({ text: '', severity: 'info' });
  const [copied, setCopied]               = useState(false);
  const [tierConfig, setTierConfig]       = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const data  = await api.get('/payment/status', token);
        if (Array.isArray(data) && data.length > 0) {
          setPaymentStatus(data[0]);
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    api.get('/tiers')
      .then(data => { if (Array.isArray(data)) setTierConfig(data); })
      .catch(() => {}); // fall back to hardcoded TIERS constant
  }, []);

  const displayTiers = tierConfig.length > 0
    ? tierConfig.map(tc => ({
        ...TIERS.find(t => t.id === tc.tier),
        price: tc.price_inr,
        assets: tc.asset_limit,
      }))
    : TIERS;

  const handleCopyUPI = () => {
    navigator.clipboard.writeText(UPI_ID);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = async () => {
    if (!selectedTier) {
      setMsg({ text: 'Please select a tier first.', severity: 'warning' });
      return;
    }
    if (!upiRef.trim()) {
      setMsg({ text: 'Please enter your UPI transaction reference number.', severity: 'warning' });
      return;
    }
    setSubmitting(true);
    setMsg({ text: '', severity: 'info' });
    try {
      const token = await getToken();
      await api.post('/payment/submit', {
        tier: selectedTier,
        upiRef: upiRef.trim(),
      }, token);
      setMsg({
        text: 'Payment submitted successfully! The developer will verify and activate your plan within a few hours.',
        severity: 'success',
      });
      setUpiRef('');
      const data = await api.get('/payment/status', token);
      if (Array.isArray(data) && data.length > 0) setPaymentStatus(data[0]);
    } catch (e) {
      setMsg({ text: e.message, severity: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const currentPlan = user?.plan ?? 'free';
  const daysLeft    = user
    ? Math.max(0, Math.ceil((user.expires_at - Date.now()) / 86400000))
    : null;

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 1 }}>
        Upgrade Plan
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Unlock more assets and features. Pay via UPI — verified manually within a few hours.
      </Typography>

      {user && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Current plan: <strong>{currentPlan.toUpperCase()}</strong>
          {daysLeft !== null && ` — ${daysLeft} days remaining`}
          {` — ${user.asset_limit} asset slots`}
        </Alert>
      )}

      {paymentStatus?.status === 'pending' && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          Payment pending verification — {paymentStatus.tier} tier,
          ₹{paymentStatus.amount_inr}, ref: {paymentStatus.upi_ref}.
          You will receive a Telegram notification once approved.
        </Alert>
      )}

      {/* Tier cards */}
      <Grid container spacing={3} justifyContent="center" sx={{ mb: 4 }}>
        {displayTiers.map(tier => (
          <Grid item xs={12} sm={6} md={4} key={tier.id}>
            <Card
              onClick={() => setSelectedTier(tier.id)}
              sx={{
                border: selectedTier === tier.id
                  ? '2px solid #4488ff'
                  : tier.recommended
                  ? '1px solid #2a2a5a'
                  : '1px solid #1a1a1a',
                cursor: 'pointer',
                position: 'relative',
                height: '100%',
                transition: 'border 0.15s, box-shadow 0.15s',
                boxShadow: selectedTier === tier.id
                  ? '0 0 16px rgba(68,136,255,0.2)'
                  : 'none',
                '&:hover': {
                  borderColor: '#4488ff',
                  boxShadow: '0 0 12px rgba(68,136,255,0.15)',
                },
              }}
            >
              {tier.recommended && (
                <Chip
                  label="POPULAR"
                  size="small"
                  sx={{
                    position: 'absolute', top: -10,
                    left: '50%', transform: 'translateX(-50%)',
                    bgcolor: '#4488ff', color: '#fff',
                    fontWeight: 700, borderRadius: '4px',
                    fontSize: '0.65rem',
                  }}
                />
              )}
              {selectedTier === tier.id && (
                <CheckCircleOutlined
                  sx={{
                    position: 'absolute', top: 12, right: 12,
                    color: '#4488ff', fontSize: 20,
                  }}
                />
              )}
              <CardContent sx={{ textAlign: 'center', p: { xs: 2, md: 3 } }}>
                <Typography sx={{ fontSize: '2.5rem', mb: 1 }}>{tier.emoji}</Typography>
                <Typography variant="h5" fontWeight={700}>{tier.name}</Typography>
                <Typography variant="h3" sx={{ my: 2, color: '#4488ff', fontWeight: 700 }}>
                  ₹{tier.price}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  per 30 days · {tier.assets} assets
                </Typography>
                <Divider sx={{ my: 2 }} />
                <Stack spacing={1} sx={{ textAlign: 'left' }}>
                  {tier.features.map(f => (
                    <Stack key={f} direction="row" spacing={1} alignItems="center">
                      <CheckCircleOutlined sx={{ color: '#00c896', fontSize: 14, flexShrink: 0 }} />
                      <Typography variant="body2" color="text.secondary">{f}</Typography>
                    </Stack>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* UPI Payment Section */}
      <Paper sx={{ p: 3, maxWidth: 520, mx: 'auto' }}>
        <Typography variant="h6" gutterBottom>Complete Payment via UPI</Typography>
        <Divider sx={{ mb: 2 }} />

        {!selectedTier ? (
          <Alert severity="info">Select a plan above to proceed with payment.</Alert>
        ) : (
          <Stack spacing={2.5}>
            <Alert severity="info">
              You selected:{' '}
              <strong>
                {displayTiers.find(t => t.id === selectedTier)?.emoji}{' '}
                {selectedTier.charAt(0).toUpperCase() + selectedTier.slice(1)}
              </strong>
              {' — '}
              <strong>₹{displayTiers.find(t => t.id === selectedTier)?.price}</strong>
            </Alert>

            {/* QR Code */}
            <Box sx={{ textAlign: 'center' }}>
              <Box
                component="img"
                src="/upi-qr.png"
                alt="UPI QR Code"
                sx={{
                  width: 200, height: 200,
                  border: '1px solid #2a2a2a',
                  borderRadius: 2, p: 1,
                  bgcolor: '#fff',
                }}
                onError={e => { e.target.style.display = 'none'; }}
              />
            </Box>

            {/* UPI ID */}
            <Box sx={{ p: 2, bgcolor: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 1 }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                UPI ID
              </Typography>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="body1"
                  sx={{ fontFamily: 'monospace', color: '#4488ff', fontWeight: 600 }}>
                  {UPI_ID}
                </Typography>
                <Button
                  size="small" variant="outlined"
                  startIcon={copied ? <CheckCircleOutlined /> : <ContentCopyOutlined />}
                  onClick={handleCopyUPI}
                  sx={{ minWidth: 0, ml: 1 }}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </Button>
              </Stack>
            </Box>

            <Typography variant="body2" color="text.secondary">
              Pay the exact amount using any UPI app (GPay, PhonePe, Paytm).
              After payment, enter your UTR / transaction reference number below.
            </Typography>

            <TextField
              fullWidth
              label="UPI Transaction Reference (UTR)"
              placeholder="e.g. 427839201234"
              value={upiRef}
              onChange={e => setUpiRef(e.target.value)}
              size="small"
              helperText="Find this in your UPI app under payment history"
            />

            <Button
              variant="contained"
              fullWidth
              size="large"
              onClick={handleSubmit}
              disabled={submitting || !upiRef.trim()}
              startIcon={submitting ? <CircularProgress size={16} /> : null}
              sx={{ whiteSpace: 'nowrap' }}
            >
              {submitting ? 'Submitting...' : 'Submit for Verification'}
            </Button>

            {msg.text && <Alert severity={msg.severity}>{msg.text}</Alert>}
          </Stack>
        )}
      </Paper>
    </Container>
  );
}
