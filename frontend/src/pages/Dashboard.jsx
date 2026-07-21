import { useNavigate } from 'react-router-dom';
import {
  Box, Container, Typography, Card, CardContent,
  Stack, Chip, Skeleton, Button, Grid, Divider
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { AddOutlined } from '@mui/icons-material';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import { useAssets } from '../hooks/useAssets';
import { useUser } from '../hooks/useUser';
import { useSweepDashboard } from '../hooks/useSweep';
import ApiErrorAlert from '../components/ApiErrorAlert';

const EBP_TFS   = ['M15', '1H', '4H', 'D', 'W'];
const SWEEP_TFS = ['M5', 'M15', 'M30', '1H', '4H'];

function TFCell({ tf, signal, disabled = false }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const color = disabled
    ? (isDark ? '#1c2128' : '#e2dbd0')
    : signal === 'bull' ? theme.palette.success.main
    : signal === 'bear' ? theme.palette.error.main
    : (isDark ? '#30363d' : '#c8bfb0');

  const glow = disabled ? 'none'
    : signal === 'bull' ? `0 0 6px ${theme.palette.success.main}60`
    : signal === 'bear' ? `0 0 6px ${theme.palette.error.main}60`
    : 'none';

  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      px: 1, py: 0.75,
      border: `1px solid ${disabled
        ? (isDark ? '#1c2128' : '#e2dbd0')
        : (isDark ? '#21262d' : '#d5cec4')}`,
      borderRadius: 1,
      bgcolor: disabled
        ? (isDark ? '#0d1117' : '#ebe5db')
        : (isDark ? '#161b22' : '#f2ede4'),
      minWidth: 38,
      opacity: disabled ? 0.35 : 1,
      transition: 'none',
    }}>
      <Typography variant="overline"
        sx={{ fontSize: '0.55rem', lineHeight: 1.2 }}>
        {tf}
      </Typography>
      <Box sx={{
        width: 8, height: 8, borderRadius: '50%',
        mt: 0.5, bgcolor: color, boxShadow: glow,
        transition: 'none',
      }} />
    </Box>
  );
}

function AssetCard({ asset, onRemove, sweepStatus }) {
  const theme  = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const ebpStatus = asset.ebpStatus ?? {};
  const swpStatus = sweepStatus ?? {};
  const sweepTFs  = asset.sweep_timeframes?.split(',').map(t => t.trim()) ?? [];
  const sweepOn   = asset.sweep_enabled === 1;

  const hasBullEBP = Object.values(ebpStatus).some(s => s === 'bull');
  const hasBearEBP = Object.values(ebpStatus).some(s => s === 'bear');
  const hasBullSwp = sweepOn && Object.values(swpStatus).some(s => s === 'bull');
  const hasBearSwp = sweepOn && Object.values(swpStatus).some(s => s === 'bear');

  const hasBull = hasBullEBP || hasBullSwp;
  const hasBear = hasBearEBP || hasBearSwp;

  const border = hasBull
    ? `1px solid ${theme.palette.success.main}`
    : hasBear
    ? `1px solid ${theme.palette.error.main}`
    : `1px solid ${theme.palette.divider}`;

  const shadow = hasBull
    ? `0 0 12px ${theme.palette.success.main}25`
    : hasBear
    ? `0 0 12px ${theme.palette.error.main}25`
    : 'none';

  const typeColors = isDark ? {
    forex: '#58a6ff', commodity: '#d29922',
    index: '#bc8cff', nse_asset: '#3fb950', crypto: '#f0883e',
  } : {
    forex: '#0969da', commodity: '#92620a',
    index: '#7c3aed', nse_asset: '#1a7f37', crypto: '#bc4c00',
  };
  const typeColor = typeColors[asset.asset_type] ?? typeColors.forex;

  return (
    <Card sx={{
      border,
      boxShadow: shadow,
      mb: 1.5,
      '&:hover': {
        borderColor: hasBull ? theme.palette.success.main : hasBear ? theme.palette.error.main : theme.palette.text.disabled,
      },
    }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Grid container alignItems="center" spacing={1.5}>

          <Grid item xs={12} lg={3}>
            <Typography variant="h5"
              sx={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '1rem' }}>
              {asset.symbol}
            </Typography>
            <Chip
              label={asset.asset_type?.toUpperCase().replace('_', ' ')}
              size="small"
              sx={{
                mt: 0.5, borderRadius: '3px',
                fontSize: '0.6rem', fontWeight: 600, height: 16,
                bgcolor: `${typeColor}18`, color: typeColor,
                border: `1px solid ${typeColor}33`,
                '& .MuiChip-label': { px: 0.75 },
              }}
            />
          </Grid>

          <Grid item xs={12} lg={6}>
            {/* EBP row */}
            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
              <Typography variant="overline"
                sx={{ fontSize: '0.55rem', color: 'primary.main', width: 32, minWidth: 32, flexShrink: 0, lineHeight: 1 }}>
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
                sx={{ fontSize: '0.55rem', color: 'secondary.main', width: 32, minWidth: 32, flexShrink: 0, lineHeight: 1 }}>
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
                <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>
                  {new Date(asset.last_alert_at).toLocaleString('en-US', {
                    timeZone: 'America/New_York',
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit', hour12: true,
                  })} NY
                </Typography>
              ) : (
                <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>
                  No alerts yet
                </Typography>
              )}
              <Button size="small" color="error" variant="text"
                onClick={() => onRemove(asset.id)}
                sx={{ minWidth: 0, px: 0.5, fontSize: '0.7rem', opacity: 0.7 }}>
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
        alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>Dashboard</Typography>
        {user && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              label={user.plan?.toUpperCase() ?? 'FREE'}
              size="small"
              sx={{
                fontWeight: 700, borderRadius: '4px',
                bgcolor: 'background.default',
                color: { free:'text.secondary', coffee:'warning.main',
                  beer:'warning.main', wine:'secondary.main' }[user.plan] ?? 'text.secondary',
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

      {user?.active === 0 && (
        <Box sx={{
          position: 'fixed', inset: 0, zIndex: 1300,
          bgcolor: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(4px)',
        }}>
          <Card sx={{ maxWidth: 400, width: '90%', textAlign: 'center', p: 1 }}>
            <CardContent>
              <BoltOutlinedIcon sx={{ fontSize: 48, color: 'warning.main', mb: 1 }} />
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
                sx={{ bgcolor: 'warning.main', '&:hover': { bgcolor: 'warning.dark' } }}>
                Renew Plan
              </Button>
            </CardContent>
          </Card>
        </Box>
      )}

      <ApiErrorAlert error={error} />

      {loading ? (
        <Stack spacing={1.5}>
          {[1, 2, 3].map(i => (
            <Card key={i} sx={{ border: '1px solid', borderColor: 'divider' }}>
              <CardContent sx={{ py: 1.5 }}>
                <Grid container alignItems="center" spacing={1.5}>
                  <Grid item xs={12} lg={3}>
                    <Skeleton variant="text" width={100} height={24} />
                    <Skeleton variant="text" width={50} height={16} />
                  </Grid>
                  <Grid item xs={12} lg={6}>
                    <Stack direction="row" spacing={0.5} sx={{ mb: 0.5 }}>
                      {[1,2,3,4,5].map(j => (
                        <Skeleton key={j} variant="rectangular"
                          width={38} height={44} sx={{ borderRadius: 1 }} />
                      ))}
                    </Stack>
                    <Stack direction="row" spacing={0.5}>
                      {[1,2,3,4,5].map(j => (
                        <Skeleton key={j} variant="rectangular"
                          width={38} height={44} sx={{ borderRadius: 1 }} />
                      ))}
                    </Stack>
                  </Grid>
                  <Grid item xs={12} lg={3}>
                    <Skeleton variant="text" width={80} height={16} />
                  </Grid>
                </Grid>
              </CardContent>
            </Card>
          ))}
        </Stack>
      ) : assets.length === 0 ? (
        <Card sx={{ border: '1px solid', borderColor: 'divider' }}>
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
