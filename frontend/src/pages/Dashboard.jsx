import { useNavigate } from 'react-router-dom';
import {
  Box, Container, Typography, Card, CardContent,
  Stack, Chip, Skeleton, Button, Grid, Divider
} from '@mui/material';
import { AddOutlined } from '@mui/icons-material';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import { useAssets } from '../hooks/useAssets';
import { useUser } from '../hooks/useUser';
import { useSweepDashboard } from '../hooks/useSweep';
import ApiErrorAlert from '../components/ApiErrorAlert';

const EBP_TFS   = ['M15', '1H', '4H', 'D', 'W'];
const SWEEP_TFS = ['M5', 'M15', 'M30', '1H', '4H'];

function TFCell({ tf, signal, disabled = false }) {
  const color = disabled
    ? '#1a1a1a'
    : signal === 'bull' ? '#00c896'
    : signal === 'bear' ? '#ff4466'
    : '#2a2a2a';
  const glow = disabled ? 'none'
    : signal === 'bull' ? '0 0 6px #00c896'
    : signal === 'bear' ? '0 0 6px #ff4466'
    : 'none';
  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      px: 1.5, py: 1,
      border: `1px solid ${disabled ? '#111' : '#1a1a1a'}`,
      borderRadius: 1,
      bgcolor: disabled ? '#050505' : '#0a0a0a',
      minWidth: 44, opacity: disabled ? 0.4 : 1,
    }}>
      <Typography variant="overline"
        sx={{ fontSize: '0.6rem', color: disabled ? '#333' : '#55556a', lineHeight: 1.2 }}>
        {tf}
      </Typography>
      <Box sx={{
        width: 8, height: 8, borderRadius: '50%', mt: 0.5,
        bgcolor: color, boxShadow: glow,
      }} />
    </Box>
  );
}

function AssetCard({ asset, onRemove, sweepStatus }) {
  const ebpStatus = asset.ebpStatus ?? {};
  const swpStatus = sweepStatus ?? {};
  const sweepTFs  = asset.sweep_timeframes?.split(',').map(t => t.trim()) ?? [];
  const sweepOn   = asset.sweep_enabled === 1;

  const hasBullEBP = Object.values(ebpStatus).some(s => s === 'bull');
  const hasBearEBP = Object.values(ebpStatus).some(s => s === 'bear');
  const hasBullSwp = sweepOn && Object.values(swpStatus).some(s => s === 'bull');
  const hasBearSwp = sweepOn && Object.values(swpStatus).some(s => s === 'bear');

  const border = (hasBullEBP || hasBullSwp)
    ? '1px solid #00c896'
    : (hasBearEBP || hasBearSwp)
    ? '1px solid #ff4466'
    : '1px solid #1a1a1a';

  const shadow = (hasBullEBP || hasBullSwp)
    ? '0 0 12px rgba(0,200,150,0.15)'
    : (hasBearEBP || hasBearSwp)
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
              label={asset.asset_type?.toUpperCase().replace('_', ' ')}
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
            {/* EBP row */}
            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.75 }}>
              <Typography variant="overline"
                sx={{ fontSize: '0.55rem', color: '#4488ff', width: 28, flexShrink: 0 }}>
                EBP
              </Typography>
              <Stack direction="row" spacing={0.5}>
                {EBP_TFS.map(tf => (
                  <TFCell key={tf} tf={tf} signal={ebpStatus[tf] ?? 'none'} />
                ))}
              </Stack>
            </Stack>

            {/* Sweep row */}
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <Typography variant="overline"
                sx={{ fontSize: '0.55rem', color: '#8855ff', width: 28, flexShrink: 0 }}>
                SWP
              </Typography>
              <Stack direction="row" spacing={0.5}>
                {SWEEP_TFS.map(tf => (
                  <TFCell
                    key={tf}
                    tf={tf}
                    signal={swpStatus[tf] ?? 'none'}
                    disabled={!sweepOn || !sweepTFs.includes(tf)}
                  />
                ))}
              </Stack>
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
                    hour: '2-digit', minute: '2-digit', hour12: true,
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
  const { user }                                             = useUser();
  const { assets, loading, error, removeAsset, lastUpdated } = useAssets();
  const { sweepStatus }                                      = useSweepDashboard();

  const daysLeft = user
    ? Math.max(0, Math.ceil((user.expires_at - Date.now()) / 86400000))
    : null;

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Stack direction="row" justifyContent="space-between"
        alignItems="center" sx={{ mb: 1 }}>
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

      <Typography variant="caption" color="text.disabled" sx={{ mb: 2, display: 'block' }}>
        Auto-refreshes every 60s
        {lastUpdated && ` · Last updated ${new Date(lastUpdated).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: true,
          timeZone: 'America/New_York',
        })} NY`}
      </Typography>

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

      <ApiErrorAlert error={error} />

      {loading ? (
        <Stack spacing={2}>
          {[1, 2, 3].map(i => (
            <Card key={i} sx={{ border: '1px solid #1a1a1a' }}>
              <CardContent sx={{ py: 2 }}>
                <Grid container alignItems="center" spacing={2}>
                  <Grid item xs={12} lg={3}>
                    <Skeleton variant="text" width={120} height={32} />
                    <Skeleton variant="text" width={60} height={20} />
                  </Grid>
                  <Grid item xs={12} lg={6}>
                    <Stack direction="row" spacing={1} sx={{ mb: 0.75 }}>
                      {[1,2,3,4,5].map(j => (
                        <Skeleton key={j} variant="rectangular"
                          width={44} height={52} sx={{ borderRadius: 1 }} />
                      ))}
                    </Stack>
                    <Stack direction="row" spacing={1}>
                      {[1,2,3,4,5].map(j => (
                        <Skeleton key={j} variant="rectangular"
                          width={44} height={52} sx={{ borderRadius: 1 }} />
                      ))}
                    </Stack>
                  </Grid>
                  <Grid item xs={12} lg={3}>
                    <Skeleton variant="text" width={100} height={20} />
                  </Grid>
                </Grid>
              </CardContent>
            </Card>
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
          <AssetCard
            key={asset.id}
            asset={asset}
            onRemove={removeAsset}
            sweepStatus={sweepStatus[asset.symbol] ?? {}}
          />
        ))
      )}
    </Container>
  );
}
