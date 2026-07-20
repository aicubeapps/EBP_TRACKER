import { useUser, UserButton } from '@clerk/clerk-react'
import Badge from '../ui/Badge.jsx'

const planVariant = { FREE: 'free', COFFEE: 'coffee', BEER: 'beer', WINE: 'wine' }
const planEmoji = { FREE: '', COFFEE: '☕ ', BEER: '🍺 ', WINE: '🍷 ' }

export default function Topbar({ plan = 'FREE', daysLeft = null, pageTitle = '' }) {
  const { user } = useUser()

  return (
    <header className="h-14 bg-bg-secondary border-b border-border flex items-center justify-between px-5 shrink-0">
      <h1 className="text-sm font-semibold text-text-primary">{pageTitle}</h1>
      <div className="flex items-center gap-3">
        {daysLeft !== null && (
          <span className="text-xs text-text-muted tabular-nums">
            {daysLeft > 0 ? `${daysLeft}d left` : 'Expired'}
          </span>
        )}
        <Badge variant={planVariant[plan] || 'free'}>
          {planEmoji[plan]}{plan}
        </Badge>
        <span className="text-sm text-text-secondary">{user?.firstName || user?.username}</span>
        <UserButton afterSignOutUrl="/" />
      </div>
    </header>
  )
}
