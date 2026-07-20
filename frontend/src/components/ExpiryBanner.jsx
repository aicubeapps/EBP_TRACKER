import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import { useNavigate } from 'react-router-dom'

export default function ExpiryBanner({ daysLeft }) {
  const navigate = useNavigate()
  if (daysLeft === null || daysLeft > 7) return null

  return (
    <Alert
      severity="warning"
      sx={{ mb: 2 }}
      action={
        <Button size="small" variant="contained" color="warning" onClick={() => navigate('/upgrade')}>
          Renew
        </Button>
      }
    >
      {daysLeft <= 0
        ? 'Your plan has expired. Renew to continue receiving alerts.'
        : `Your plan expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew to stay active.`}
    </Alert>
  )
}
