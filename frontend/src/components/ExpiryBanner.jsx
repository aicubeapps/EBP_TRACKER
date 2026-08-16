import { useUser } from '../hooks/useUser';

export default function ExpiryBanner() {
  const { user } = useUser();

  if (!user || user.active === 0) return null;

  const daysLeft = Math.ceil((user.expires_at - Date.now()) / 86400000);
  if (daysLeft > 7) return null;

  const kind = daysLeft <= 2 ? 'error' : 'warning';
  const text = daysLeft <= 0
    ? 'Your account expires today. Contact admin for extension.'
    : `Your account expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Contact admin for extension.`;

  return (
    <div className={`banner banner-${kind}`} style={{ borderRadius: 0, margin: 0 }}>
      <span>{text}</span>
    </div>
  );
}
