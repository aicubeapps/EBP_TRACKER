import { useNavigate } from 'react-router-dom';
import {
  Box, Container, Typography, Card, CardContent,
  Stack, Chip, Alert, Skeleton, Button, Grid, Divider
} from '@mui/material';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import { AddOutlined } from '@mui/icons-material';
import { useAssets } from '../hooks/useAssets';
import { useUser } from '../hooks/useUser';

const TF_LIST = ['W', 'D', '4H', '1H', 'M15'];

function TFCell({ tf, signal }) {
  const color = signal === 'bull'
    ? '#00c896'
    : signal === 'bear'
    ? '#ff4466'
    : '#2a2a2a';
  const glow = signal === 'bull'
    ? '0 0 6px #00c896'
    : signal === 'bear'
    ? '0 0 6px #ff4466'
    : 'none';
  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      px: 1.5, py: 1, border: '1px solid #1a1a1a',
      borderRadius: 1, bgcolor: '#0a0a0a', minWidth: 44,
    }}>
      <Typography variant="overline"
        sx={{ fontSize: '0.6rem', color: '#55556a', lineHeight: 1.2 }}>
        {tf}
      </Typography>
      <Box sx={{
        width: 8, height: 8, borderRadius: '50%',
        mt: 0.5, bgcolor: color, boxShadow: glow,
      }} />
    </Box>
  );
}

function AssetCard({ asset, onRemove }) {
  const status   = asset.ebpStatus ?? {};
  const hasBull  = Object.values(status).some(s => s === 'bull');
  const hasBear  = Object.values(status).some(s => s === 'bear');
  const border   = hasBull
    ? '1px solid #00c896'
    : hasBear
    ? '1px solid #ff4466'
    : '1px solid #1a1a1a';
  const shadow   = hasBull
    ? '0 0 12px rgba(0,200,150,0.15)'
    : hasBear
    ? '0 0 12px rgba(255,68,102,0.15)'
    : 'none';
  const typeColors = {
    forex: '#4488ff', commodity: '#f5a623',
    index: '#8855ff', nse_asset: '#00c896', crypto: '#ff8c00',
  };
  const typeColor = typeColors[asset.asset_type] ?? '#4488ff';

  return (
    <Card sx={{ border, boxShadow: shadow, mb: 2 }}>
      <CardContent sx={{ py: 2 }}>
        <Grid container alignItems="center" spacing={2}>

          <Grid item xs={12} lg={3}>
            <Typography variant="h5"
              sx={{ fontWeight: 700, fontFamily: 'monospace' }}>
              {asset.symbol}
            </Typography>
            <Chip
              label={asset.asset_type?.toUpperCase().replace('_',' ')}
              size="small"
              sx={{
                mt: 0.5, borderRadius: '4px',
                fontSize: '0.65rem', fontWeight: 700, height: 18,
                bgcolor: `${typeColor}22`, color: typeColor,
                border: `1px solid ${typeColor}44`,
              }}
            />
          </Grid>

          <Grid item xs={12} lg={6}>
            <Stack direction="row" spacing={1}
              justifyContent={{ xs: 'space-between', lg: 'center' }}>
              {TF_LIST.map(tf => (
                <TFCell key={tf} tf={tf} signal={status[tf] ?? 'none'} />
              ))}
            </Stack>
          </Grid>

          <Grid item xs={12} lg={3}>
            <Stack
              direction={{ xs: 'row', lg: 'column' }}
              alignItems={{ xs: 'center', lg: 'flex-end' }}
              justifyContent="space-between" spacing={1}>
              {asset.last_alert_at ? (
                <Typography variant="caption" color="text.secondary">
                  {new Date(asset.last_alert_at).toLocaleString('en-US', {
                    timeZone: 'America/New_York',
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })} NY
                </Typography>
              ) : (
                <Typography variant="caption" color="text.disabled">
                  No alerts yet
                </Typography>
              )}
              <Button size="small" color="error" variant="outlined"
                onClick={() => onRemove(asset.id)}
                sx={{ minWidth: 0, px: 1, fontSize: '0.7rem' }}>
                Remove
              </Button>
            </Stack>
          </Grid>

        </Grid>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user }                                = useUser();
  const { assets, loading, error, removeAsset } = useAssets();

  const daysLeft = user
    ? Math.max(0, Math.ceil((user.expires_at - Date.now()) / 86400000))
    : null;

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Stack direction="row" justifyContent="space-between"
        alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>Dashboard</Typography>
        {user && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              label={user.plan?.toUpperCase() ?? 'FREE'}
              size="small"
              sx={{
                fontWeight: 700, borderRadius: '4px',
                bgcolor: { free:'#1a1a1a', coffee:'#2a1f00',
                  beer:'#1a1200', wine:'#1a0020' }[user.plan] ?? '#1a1a1a',
                color: { free:'#888', coffee:'#f5a623',
                  beer:'#ff8c00', wine:'#8855ff' }[user.plan] ?? '#888',
              }}
            />
            {daysLeft !== null && (
              <Typography variant="caption"
                color={daysLeft <= 7 ? 'error' : 'text.secondary'}>
                {daysLeft}d left
              </Typography>
            )}
          </Stack>
        )}
      </Stack>

      {daysLeft !== null && daysLeft <= 7 && daysLeft > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Account expires in {daysLeft} day{daysLeft !== 1 ? 's' : ''}.
          <Button size="small" sx={{ ml: 1 }}
            onClick={() => navigate('/upgrade')}>Renew</Button>
        </Alert>
      )}

      {user?.active === 0 && (
        <Box sx={{
          position: 'fixed', inset: 0, zIndex: 1300,
          bgcolor: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(4px)',
        }}>
          <Card sx={{ maxWidth: 400, width: '90%', textAlign: 'center', p: 1 }}>
            <CardContent>
              <BoltOutlinedIcon sx={{ fontSize: 48, color: '#f5a623', mb: 1 }} />
              <Typography variant="h5" fontWeight={700} sx={{ mb: 1 }}>
                Plan Expired
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Your EBP Tracker subscription has expired. Renew to continue
                receiving alerts and monitoring your assets.
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Button variant="contained" size="large" fullWidth
                startIcon={<BoltOutlinedIcon />}
                onClick={() => navigate('/upgrade')}
                sx={{ bgcolor: '#f5a623', '&:hover': { bgcolor: '#d4891f' } }}>
                Renew Plan
              </Button>
            </CardContent>
          </Card>
        </Box>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Stack spacing={2}>
          {[1,2,3].map(i => (
            <Skeleton key={i} variant="rectangular"
              height={100} sx={{ borderRadius: 2 }} />
          ))}
        </Stack>
      ) : assets.length === 0 ? (
        <Card sx={{ border: '1px solid #1a1a1a' }}>
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No assets tracked yet
            </Typography>
            <Typography variant="body2" color="text.disabled" sx={{ mb: 3 }}>
              Add your first asset to start receiving EBP alerts
            </Typography>
            <Button variant="contained" startIcon={<AddOutlined />}
              onClick={() => navigate('/assets')}>
              Add Asset
            </Button>
          </CardContent>
        </Card>
      ) : (
        assets.map(asset => (
          <AssetCard key={asset.id} asset={asset} onRemove={removeAsset} />
        ))
      )}
    </Container>
  );
}
