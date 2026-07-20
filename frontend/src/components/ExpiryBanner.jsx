import { AlertTriangle } from 'lucide-react'
import Button from './ui/Button.jsx'
import { useNavigate } from 'react-router-dom'

export default function ExpiryBanner({ daysLeft }) {
  const navigate = useNavigate()
  if (daysLeft === null || daysLeft > 7) return null

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 bg-accent-yellow/10 border border-accent-yellow/20 rounded-lg mb-4">
      <div className="flex items-center gap-2 text-accent-yellow">
        <AlertTriangle size={16} />
        <span className="text-sm font-medium">
          {daysLeft <= 0
            ? 'Your plan has expired. Renew to continue receiving alerts.'
            : `Your plan expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew to stay active.`}
        </span>
      </div>
      <Button variant="primary" size="sm" onClick={() => navigate('/upgrade')}>
        Renew Now
      </Button>
    </div>
  )
}
