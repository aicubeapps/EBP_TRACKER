import Sidebar from './Sidebar.jsx'
import Topbar from './Topbar.jsx'
import { useLocation } from 'react-router-dom'

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

  return (
    <div className="flex h-screen bg-bg-primary overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <Topbar pageTitle={pageTitle} plan="FREE" daysLeft={null} />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
