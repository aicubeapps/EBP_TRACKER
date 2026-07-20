import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  BarChart2,
  Bell,
  Settings,
  Zap,
  Shield,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/assets', label: 'Assets', icon: BarChart2 },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/upgrade', label: 'Upgrade', icon: Zap },
  { to: '/admin', label: 'Admin', icon: Shield },
]

export default function Sidebar({ mobile = false, onClose }) {
  const [collapsed, setCollapsed] = useState(() => {
    if (mobile) return false
    return localStorage.getItem('ebp_sidebar_collapsed') === 'true'
  })

  useEffect(() => {
    if (!mobile) {
      localStorage.setItem('ebp_sidebar_collapsed', collapsed)
    }
  }, [collapsed, mobile])

  const toggle = () => setCollapsed((c) => !c)

  const width = mobile ? 'w-60' : collapsed ? 'w-14' : 'w-60'

  return (
    <aside
      className={`${width} bg-bg-secondary border-r border-border flex flex-col h-full transition-all duration-200 shrink-0`}
    >
      {/* Logo / wordmark */}
      {!collapsed && (
        <div className="px-4 py-5 border-b border-border flex items-center gap-2.5">
          <img src="/favicon.svg" alt="EBP Tracker" className="w-7 h-7 shrink-0" />
          <span className="text-sm font-bold text-text-primary tracking-wide whitespace-nowrap">
            EBP Tracker
          </span>
        </div>
      )}
      {collapsed && (
        <div className="py-5 border-b border-border flex justify-center">
          <img src="/favicon.svg" alt="EBP Tracker" className="w-7 h-7" />
        </div>
      )}

      {/* Nav items */}
      <nav className="flex-1 py-3 overflow-hidden">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={mobile ? onClose : undefined}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              `flex items-center gap-3 py-2.5 mx-2 rounded-lg text-sm font-medium transition-colors duration-100 ${
                collapsed ? 'justify-center px-0' : 'px-3'
              } ${
                isActive
                  ? 'bg-bg-elevated text-text-primary border-l-2 border-accent-blue -ml-[1px] pl-[calc(0.75rem_-_1px)]'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated border-l-2 border-transparent'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon size={16} className={isActive ? 'text-accent-blue' : ''} />
                {!collapsed && <span className="whitespace-nowrap">{label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Bottom: collapse toggle (desktop only) */}
      {!mobile && (
        <div className="border-t border-border p-2">
          <button
            onClick={toggle}
            className={`w-full flex items-center py-2 px-2 rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-elevated transition-colors ${
              collapsed ? 'justify-center' : 'justify-end'
            }`}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>
      )}
    </aside>
  )
}
