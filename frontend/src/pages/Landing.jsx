import { SignInButton } from '@clerk/clerk-react';
import { useParams } from 'react-router-dom';

export default function Landing() {
  const { token } = useParams();

  return (
    <div className="landing-shell">
      <img src="/favicon.svg" alt="EBP Tracker" className="landing-logo" />

      <h1 className="landing-title">EBP Tracker</h1>
      <p className="landing-tagline">Precision alerts for engulfing bar prints.</p>
      <p className="landing-sub">Forex · Commodities · Indices · Indian Markets</p>

      {token && (
        <div className="landing-invite">
          Invite token active: <strong style={{ fontFamily: 'var(--font-mono)' }}>{token}</strong>
        </div>
      )}

      <SignInButton mode="modal" redirectUrl="/dashboard">
        <button className="btn btn-primary btn-lg">
          <svg viewBox="0 0 24 24" style={{ width: 18, height: 18 }} fill="currentColor">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Sign in with Google
        </button>
      </SignInButton>

      <p className="landing-footer">Invite only access · By invitation only</p>
    </div>
  );
}
