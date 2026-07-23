import { useNavigate } from 'react-router-dom';
import {
  Box, Container, Typography, Card, CardContent,
  Stack, Chip, Skeleton, Button, Divider
} from '@mui/material';
import { AddOutlined } from '@mui/icons-material';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import { useAssets } from '../hooks/useAssets';
import { useUser } from '../hooks/useUser';
import ApiErrorAlert from '../components/ApiErrorAlert';
import AssetCard from '../components/AssetCard';

export default function Dashboard() {
  const navigate = useNavigate();
  const { user }                                             = useUser();
  const { assets, loading, error, removeAsset, lastUpdated } = useAssets();

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
        <Box sx={{ maxWidth: 680, mx: 'auto' }}>
          <Stack spacing={2}>
            {[1, 2, 3].map(i => (
              <Card key={i} sx={{ border: '1px solid', borderColor: 'divider' }}>
                <CardContent sx={{ py: 2 }}>
                  <Skeleton variant="text" width={120} height={28} />
                  <Skeleton variant="text" width={60} height={16} />
                  <Skeleton variant="text" width={200} height={16} sx={{ mt: 1 }} />
                </CardContent>
              </Card>
            ))}
          </Stack>
        </Box>
      ) : assets.length === 0 ? (
        <Box sx={{ maxWidth: 680, mx: 'auto' }}>
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
        </Box>
      ) : (
        <Box sx={{ maxWidth: 680, mx: 'auto' }}>
          {assets.map(asset => (
            <AssetCard
              key={asset.id}
              asset={asset}
              onRemove={removeAsset}
            />
          ))}
        </Box>
      )}
    </Container>
  );
}
