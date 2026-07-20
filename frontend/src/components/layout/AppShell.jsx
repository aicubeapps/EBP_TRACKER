import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar.jsx'
import Topbar from './Topbar.jsx'

const pageTitles = {
  '/dashboard': 'Dashboard',
  '/assets': 'Assets',
  '/alerts': 'Alert History',
  '/settings': 'Settings',
  '/upgrade': 'Upgrade Plan',
  '/admin': 'Admin Panel',
}

export default function AppShell({ children }) {
  const { pathname } = useLocation()
  const pageTitle = pageTitles[pathname] || ''
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex h-screen bg-bg-primary overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 lg:hidden">
            <Sidebar mobile onClose={() => setMobileOpen(false)} />
          </div>
        </>
      )}

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">
        <Topbar
          pageTitle={pageTitle}
          plan="FREE"
          daysLeft={null}
          onMenuClick={() => setMobileOpen(true)}
        />
        <main className="flex-1 overflow-y-auto px-4 py-5 lg:px-6 lg:py-6">
          {children}
        </main>
      </div>
    </div>
  )
}
