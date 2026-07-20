import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  BarChart2,
  Bell,
  Settings,
  TrendingUp,
  ShieldCheck,
} from 'lucide-react'

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/assets', label: 'Assets', icon: BarChart2 },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/upgrade', label: 'Upgrade', icon: TrendingUp },
  { to: '/admin', label: 'Admin', icon: ShieldCheck },
]

export default function Sidebar() {
  return (
    <aside className="w-56 shrink-0 bg-bg-secondary border-r border-border flex flex-col h-full">
      <div className="px-4 py-5 border-b border-border">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="EBP Tracker" className="w-7 h-7" />
          <span className="text-sm font-bold text-text-primary tracking-wide">EBP Tracker</span>
        </div>
      </div>
      <nav className="flex-1 py-3">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm font-medium transition-colors duration-100 ${
                isActive
                  ? 'bg-accent-blue/10 text-accent-blue border-l-2 border-accent-blue -ml-[1px] pl-[17px]'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="px-4 py-4 border-t border-border text-xs text-text-muted">
        v0.1.0 · Invite only
      </div>
    </aside>
  )
}
