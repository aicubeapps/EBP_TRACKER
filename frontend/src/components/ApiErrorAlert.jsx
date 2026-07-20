import { Alert, Button } from '@mui/material';

export default function ApiErrorAlert({ error, onRetry }) {
  if (!error) return null;
  return (
    <Alert severity="error" sx={{ mb: 2 }}
      action={onRetry && (
        <Button color="inherit" size="small" onClick={onRetry}>
          Retry
        </Button>
      )}>
      {error}
    </Alert>
  );
}
