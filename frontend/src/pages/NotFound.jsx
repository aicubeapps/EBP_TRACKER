import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <div className="min-h-screen bg-bg-primary flex flex-col items-center justify-center text-center px-4">
      <p className="text-7xl font-bold text-border mb-4 tabular-nums">404</p>
      <h1 className="text-xl font-semibold text-text-primary mb-2">Page not found</h1>
      <p className="text-sm text-text-muted mb-6">The page you're looking for doesn't exist.</p>
      <Link
        to="/dashboard"
        className="px-4 py-2 bg-accent-blue text-white text-sm font-medium rounded-lg hover:bg-accent-blue/90 transition-colors"
      >
        Return to Dashboard
      </Link>
    </div>
  )
}
