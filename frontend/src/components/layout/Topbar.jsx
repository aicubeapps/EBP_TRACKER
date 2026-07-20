import { useUser, UserButton } from '@clerk/clerk-react'
import { Menu } from 'lucide-react'
import Badge from '../ui/Badge.jsx'

const planVariant = { FREE: 'free', COFFEE: 'coffee', BEER: 'beer', WINE: 'wine' }
const planEmoji = { FREE: '', COFFEE: '☕ ', BEER: '🍺 ', WINE: '🍷 ' }

export default function Topbar({ plan = 'FREE', daysLeft = null, pageTitle = '', onMenuClick }) {
  const { user } = useUser()

  return (
    <header className="h-14 bg-bg-secondary border-b border-border flex items-center justify-between px-4 lg:px-5 shrink-0">
      {/* Left — hamburger (mobile) or page title (desktop) */}
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-1.5 -ml-1 text-text-muted hover:text-text-primary rounded transition-colors"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        {/* Wordmark centered on mobile */}
        <span className="lg:hidden text-sm font-bold text-text-primary tracking-wide">
          EBP Tracker
        </span>
        <h1 className="hidden lg:block text-sm font-semibold text-text-primary">{pageTitle}</h1>
      </div>

      {/* Right — plan badge + expiry + avatar */}
      <div className="flex items-center gap-2 lg:gap-3">
        {daysLeft !== null && (
          <span className="hidden lg:block text-xs text-text-muted tabular-nums">
            {daysLeft > 0 ? `${daysLeft}d left` : 'Expired'}
          </span>
        )}
        <span className="hidden lg:block">
          <Badge variant={planVariant[plan] || 'free'}>
            {planEmoji[plan]}{plan}
          </Badge>
        </span>
        <span className="hidden lg:block text-sm text-text-secondary">
          {user?.firstName || user?.username}
        </span>
        <UserButton afterSignOutUrl="/" />
      </div>
    </header>
  )
}
