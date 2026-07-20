import { useNavigate } from 'react-router-dom';
import { Alert, Button } from '@mui/material';
import { useUser } from '../hooks/useUser';

export default function ExpiryBanner() {
  const { user } = useUser();
  const navigate = useNavigate();

  if (!user || user.active === 0) return null;

  const daysLeft = Math.ceil((user.expires_at - Date.now()) / 86400000);
  if (daysLeft > 7) return null;

  const severity = daysLeft <= 2 ? 'error' : 'warning';
  const msg = daysLeft <= 0
    ? 'Your account expires today.'
    : `Your account expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.`;

  return (
    <Alert severity={severity} sx={{ borderRadius: 0, mb: 0 }}
      action={
        <Button color="inherit" size="small" onClick={() => navigate('/upgrade')}>
          Renew
        </Button>
      }>
      {msg}
    </Alert>
  );
}
