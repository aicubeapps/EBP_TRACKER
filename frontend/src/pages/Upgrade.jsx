import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { useUser } from '../hooks/useUser';
import { capitalise, daysRemaining } from '../lib/utils';

const TIERS = [
  {
    id: 'coffee', emoji: '☕', name: 'Coffee', price: 99, assets: 5,
    features: ['5 asset slots', 'All 5 timeframes', 'Telegram alerts', 'Alert history', 'Valid 30 days'],
  },
  {
    id: 'beer', emoji: '🍺', name: 'Beer', price: 249, assets: 8, recommended: true,
    features: ['8 asset slots', 'All 5 timeframes', 'Telegram alerts', 'Alert history', 'Valid 30 days'],
  },
  {
    id: 'wine', emoji: '🍷', name: 'Wine', price: 499, assets: 13,
    features: ['13 asset slots', 'All 5 timeframes', 'Custom TF pairing', 'Telegram alerts', 'Priority support', 'Valid 30 days'],
  },
];

const UPI_ID = '8087778493@ybl';

export default function Upgrade() {
  const { getToken }                    = useAuth();
  const { user }                        = useUser();
  const [selectedTier, setSelectedTier] = useState(null);
  const [upiRef, setUpiRef]             = useState('');
  const [submitting, setSubmitting]     = useState(false);
  const [paymentStatus, setPaymentStatus] = useState(null);
  const [msg, setMsg]                   = useState({ text: '', kind: 'info' });
  const [copied, setCopied]             = useState(false);
  const [tierConfig, setTierConfig]     = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const data  = await api.get('/payment/status', token);
        if (Array.isArray(data) && data.length > 0) setPaymentStatus(data[0]);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    api.get('/tiers')
      .then(data => { if (Array.isArray(data)) setTierConfig(data); })
      .catch(() => {});
  }, []);

  const displayTiers = tierConfig.length > 0
    ? tierConfig.map(tc => ({
        ...TIERS.find(t => t.id === tc.tier),
        price: tc.price_inr,
        assets: tc.asset_limit,
      }))
    : TIERS;

  const handleCopyUPI = () => {
    navigator.clipboard.writeText(UPI_ID);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = async () => {
    if (!selectedTier) {
      setMsg({ text: 'Please select a tier first.', kind: 'warning' });
      return;
    }
    if (!upiRef.trim()) {
      setMsg({ text: 'Please enter your UPI transaction reference number.', kind: 'warning' });
      return;
    }
    setSubmitting(true);
    setMsg({ text: '', kind: 'info' });
    try {
      const token = await getToken();
      await api.post('/payment/submit', { tier: selectedTier, upiRef: upiRef.trim() }, token);
      setMsg({ text: 'Payment submitted successfully! The developer will verify and activate your plan within a few hours.', kind: 'success' });
      setUpiRef('');
      const data = await api.get('/payment/status', token);
      if (Array.isArray(data) && data.length > 0) setPaymentStatus(data[0]);
    } catch (e) {
      setMsg({ text: e.message, kind: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const currentPlan = user?.plan ?? 'free';

  return (
    <div className="shell-wide">
      <div className="page-title">Upgrade Plan</div>
      <p className="page-subtitle">Unlock more assets and features. Pay via UPI — verified manually within a few hours.</p>

      {user && (
        <div className="banner banner-info">
          Current plan: <strong>{capitalise(currentPlan)}</strong>
          {` — ${daysRemaining(user.expires_at)} days remaining — ${user.asset_limit} asset slots`}
        </div>
      )}

      {paymentStatus?.status === 'pending' && (
        <div className="banner banner-warning">
          Payment pending verification — {paymentStatus.tier} tier, ₹{paymentStatus.amount_inr}, ref: {paymentStatus.upi_ref}.
          You will receive a Telegram notification once approved.
        </div>
      )}

      <div className="pricing-grid">
        {displayTiers.map(tier => (
          <div
            key={tier.id}
            className={`pricing-card ${selectedTier === tier.id ? 'selected' : ''} ${tier.recommended ? 'recommended' : ''}`}
            onClick={() => setSelectedTier(tier.id)}
          >
            {tier.recommended && <span className="pricing-badge">POPULAR</span>}
            <div className="pricing-emoji">{tier.emoji}</div>
            <div className="pricing-name">{tier.name}</div>
            <div className="pricing-price">₹{tier.price}</div>
            <div className="pricing-meta">per 30 days · {tier.assets} assets</div>
            <ul className="pricing-features">
              {tier.features.map(f => <li key={f}>{f}</li>)}
            </ul>
          </div>
        ))}
      </div>

      <div className="card upi-box">
        <div className="section-heading">Complete Payment via UPI</div>

        {!selectedTier ? (
          <div className="banner banner-info">Select a plan above to proceed with payment.</div>
        ) : (
          <>
            <div className="banner banner-info">
              You selected:{' '}
              <strong>
                {displayTiers.find(t => t.id === selectedTier)?.emoji} {capitalise(selectedTier)}
              </strong>
              {' — '}
              <strong>₹{displayTiers.find(t => t.id === selectedTier)?.price}</strong>
            </div>

            <img
              src="/upi-qr.png"
              alt="UPI QR Code"
              className="upi-qr"
              onError={e => { e.target.style.display = 'none'; }}
            />

            <div className="upi-id-box">
              <div>
                <span className="input-label" style={{ marginBottom: 2 }}>UPI ID</span>
                <span className="upi-id-value">{UPI_ID}</span>
              </div>
              <button className="btn btn-outline btn-sm" onClick={handleCopyUPI}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <p className="text-muted mb-md" style={{ fontSize: 12 }}>
              Pay the exact amount using any UPI app (GPay, PhonePe, Paytm).
              After payment, enter your UTR / transaction reference number below.
            </p>

            <label className="input-label">UPI Transaction Reference (UTR)</label>
            <input
              className="input mb-sm"
              placeholder="e.g. 427839201234"
              value={upiRef}
              onChange={e => setUpiRef(e.target.value)}
            />
            <p className="input-hint mb-md">Find this in your UPI app under payment history</p>

            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={handleSubmit}
              disabled={submitting || !upiRef.trim()}
            >
              {submitting ? <span className="spinner" /> : null} {submitting ? 'Submitting...' : 'Submit for Verification'}
            </button>

            {msg.text && <div className={`banner banner-${msg.kind} mt-md`}>{msg.text}</div>}
          </>
        )}
      </div>
    </div>
  );
}
