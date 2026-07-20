import { SignInButton } from '@clerk/clerk-react'
import { useParams } from 'react-router-dom'

export default function Landing() {
  const { token } = useParams()

  return (
    <div className="min-h-screen bg-bg-primary dot-grid flex flex-col items-center justify-center px-4 relative overflow-hidden">
      {/* Radial gradient overlay */}
      <div className="absolute inset-0 bg-radial-gradient pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, rgba(68,136,255,0.05) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 flex flex-col items-center text-center max-w-lg">
        <img src="/favicon.svg" alt="EBP Tracker" className="w-16 h-16 mb-6" />

        <h1 className="text-4xl font-bold text-text-primary mb-3 tracking-tight">
          EBP Tracker
        </h1>

        <p className="text-base text-text-secondary mb-2 leading-relaxed">
          Precision alerts for engulfing bar prints.
        </p>
        <p className="text-sm text-text-muted mb-8">
          Forex · Commodities · Indices · Indian Markets
        </p>

        {token && (
          <div className="mb-6 px-4 py-2 bg-accent-blue/10 border border-accent-blue/20 rounded-lg text-sm text-accent-blue">
            Invite token active: <span className="font-mono font-semibold">{token}</span>
          </div>
        )}

        <SignInButton mode="modal" redirectUrl="/dashboard">
          <button className="flex items-center gap-3 px-6 py-3 bg-accent-blue hover:bg-accent-blue/90 text-white font-semibold rounded-lg transition-colors duration-150 shadow-lg shadow-accent-blue/20">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#fff" opacity=".9"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#fff" opacity=".9"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#fff" opacity=".9"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#fff" opacity=".9"/>
            </svg>
            Sign in with Google
          </button>
        </SignInButton>

        <p className="mt-8 text-xs text-text-muted">
          Invite only access · By invitation only
        </p>
      </div>
    </div>
  )
}
