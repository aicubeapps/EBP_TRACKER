import { useNavigate } from 'react-router-dom';
import { useUser } from '../hooks/useUser';

export default function ExpiryBanner() {
  const { user } = useUser();
  const navigate = useNavigate();

  if (!user || user.active === 0) return null;

  const daysLeft = Math.ceil((user.expires_at - Date.now()) / 86400000);
  if (daysLeft > 7) return null;

  const kind = daysLeft <= 2 ? 'error' : 'warning';
  const text = daysLeft <= 0
    ? 'Your account expires today.'
    : `Your account expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.`;

  return (
    <div className={`banner banner-${kind}`} style={{ borderRadius: 0, margin: 0 }}>
      <span>{text}</span>
      <button className="banner-action" onClick={() => navigate('/upgrade')}>Renew</button>
    </div>
  );
}
