import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import {
  Box, Container, Typography, Card, CardContent,
  Stack, Skeleton, Button, Divider, TextField,
  CircularProgress, InputAdornment,
} from '@mui/material';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import { useAssets } from '../hooks/useAssets';
import { useUser } from '../hooks/useUser';
import ApiErrorAlert from '../components/ApiErrorAlert';
import AssetCard from '../components/AssetCard';
import api from '../lib/api';

export default function Dashboard() {
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const { user }                                             = useUser();
  const { assets, loading, error, addAsset, removeAsset }    = useAssets();

  const [query, setQuery]                 = useState('');
  const [validationState, setValidationState] = useState(null); // null | 'validating' | 'invalid' | 'duplicate'
  const [addError, setAddError]           = useState(null);

  async function handleAddAsset() {
    const symbol = query.trim().toUpperCase();
    if (!symbol) return;
    setAddError(null);

    if (assets.some(a => a.symbol === symbol)) {
      setValidationState('duplicate');
      return;
    }

    setValidationState('validating');
    try {
      const token = await getToken();
      const data  = await api.get(`/user/assets/validate?symbol=${encodeURIComponent(symbol)}`, token);
      if (!data.valid) {
        setValidationState('invalid');
        return;
      }
      await addAsset(symbol, symbol, data.asset_type ?? 'forex');
      setValidationState(null);
      setQuery('');
    } catch (e) {
      setValidationState(null);
      setAddError(e.message);
    }
  }

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Box sx={{ maxWidth: 680, mx: 'auto', mb: 3 }}>
        <TextField
          placeholder="Search and add asset (e.g. EUR/USD, NIFTY, BTC/USD)"
          fullWidth
          value={query}
          onChange={e => { setQuery(e.target.value); setValidationState(null); }}
          onKeyDown={e => e.key === 'Enter' && handleAddAsset()}
          disabled={validationState === 'validating'}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                {validationState === 'validating' ? (
                  <CircularProgress size={18} />
                ) : (
                  <Button size="small" onClick={handleAddAsset} disabled={!query.trim()}>
                    Add
                  </Button>
                )}
              </InputAdornment>
            ),
          }}
        />
        {validationState === 'invalid' && (
          <Typography variant="caption" color="error" sx={{ mt: 0.5, display: 'block' }}>
            Symbol not found — please check and try again
          </Typography>
        )}
        {validationState === 'duplicate' && (
          <Typography variant="caption" color="warning.main" sx={{ mt: 0.5, display: 'block' }}>
            Already in your watchlist
          </Typography>
        )}
        {addError && (
          <Typography variant="caption" color="error" sx={{ mt: 0.5, display: 'block' }}>
            {addError}
          </Typography>
        )}
      </Box>

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
            <Typography variant="body2" color="text.disabled">
              Search for a symbol above to start receiving alerts
            </Typography>
          </CardContent>
        </Card>
        </Box>
      ) : (
        <Box sx={{ maxWidth: 680, mx: 'auto' }}>
          {assets.map(asset => (
            <AssetCard
              key={asset.id}
              asset={asset}
              tier={user?.plan ?? 'free'}
              onRemove={removeAsset}
            />
          ))}
        </Box>
      )}
    </Container>
  );
}
