import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { useAssets } from '../hooks/useAssets';
import { useUser } from '../hooks/useUser';
import ApiErrorAlert from '../components/ApiErrorAlert';
import AssetCard from '../components/AssetCard';
import api from '../lib/api';

export default function Dashboard() {
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const { user }                                          = useUser();
  const { assets, loading, error, addAsset, removeAsset } = useAssets();

  const [query, setQuery]                     = useState('');
  const [validationState, setValidationState] = useState(null); // null | 'validating' | 'invalid' | 'duplicate'
  const [addError, setAddError]               = useState(null);

  async function handleAddAsset() {
    const symbol = query.trim().toUpperCase();
    if (!symbol) return;
    setAddError(null);

    if (assets.some(a => a.symbol === symbol)) {
      setValidationState('duplicate');
      return;
    }

    setValidationState('validating');
    try {
      const token = await getToken();
      const data  = await api.get(`/user/assets/validate?symbol=${encodeURIComponent(symbol)}`, token);
      if (!data.valid) {
        setValidationState('invalid');
        return;
      }
      await addAsset(symbol, symbol, data.asset_type ?? 'forex');
      setValidationState(null);
      setQuery('');
    } catch (e) {
      setValidationState(null);
      setAddError(e.message);
    }
  }

  return (
    <div className="shell">
      <div className="search-bar">
        <div className="search-input-wrap">
          <input
            className="search-input"
            placeholder="Search and add asset — EUR/USD, NIFTY, BTC/USD…"
            value={query}
            onChange={e => { setQuery(e.target.value); setValidationState(null); setAddError(null); }}
            onKeyDown={e => e.key === 'Enter' && handleAddAsset()}
            disabled={validationState === 'validating'}
          />
          <button
            className="search-btn"
            onClick={handleAddAsset}
            disabled={validationState === 'validating' || !query.trim()}
          >
            {validationState === 'validating' ? '…' : 'Add'}
          </button>
        </div>
        {validationState === 'invalid' && (
          <span className="search-msg error">Symbol not found — please check and try again</span>
        )}
        {validationState === 'duplicate' && (
          <span className="search-msg warning">Already in your watchlist</span>
        )}
        {addError && (
          <span className="search-msg error">{addError}</span>
        )}
      </div>

      {user?.active === 0 && (
        <div className="overlay">
          <div className="card overlay-card">
            <div className="overlay-icon">⚡</div>
            <div className="card-title mb-sm">Plan Expired</div>
            <p className="text-muted mb-md" style={{ fontSize: 12 }}>
              Your EBP Tracker subscription has expired. Renew to continue receiving alerts and monitoring your assets.
            </p>
            <div className="divider" />
            <button className="btn btn-primary btn-lg btn-block" onClick={() => navigate('/upgrade')}>
              Renew Plan
            </button>
          </div>
        </div>
      )}

      <ApiErrorAlert error={error} />

      {loading ? (
        <>
          {[1, 2, 3].map(i => (
            <div key={i} className="card">
              <div className="skeleton" style={{ width: 120, height: 20, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: 60, height: 12, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: 200, height: 12 }} />
            </div>
          ))}
        </>
      ) : assets.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p className="text-muted" style={{ fontSize: 13 }}>
            No assets yet — search above to add your first asset
          </p>
        </div>
      ) : (
        assets.map(asset => (
          <AssetCard
            key={asset.id}
            asset={asset}
            tier={user?.plan ?? 'free'}
            onRemove={removeAsset}
          />
        ))
      )}
    </div>
  );
}
