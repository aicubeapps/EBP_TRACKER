import { useNavigate } from 'react-router-dom';

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="notfound-shell">
      <div className="notfound-code tabular-nums">404</div>
      <div className="notfound-title">Page not found</div>
      <p className="notfound-desc">The page you're looking for doesn't exist.</p>
      <button className="btn btn-primary" onClick={() => navigate('/dashboard')}>Return to Dashboard</button>
    </div>
  );
}
