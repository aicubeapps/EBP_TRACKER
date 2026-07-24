import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useAssets } from '../hooks/useAssets';
import { useUser } from '../hooks/useUser';
import ApiErrorAlert from '../components/ApiErrorAlert';
import AssetCard from '../components/AssetCard';
import api from '../lib/api';

function fmtTZ(ts, tz, locale) {
  if (!ts) return null;
  return new Date(ts).toLocaleTimeString(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

export default function Dashboard() {
  const { getToken } = useAuth();
  const { user }                                          = useUser();
  const { assets, loading, error, addAsset, removeAsset } = useAssets();

  const [query, setQuery]                     = useState('');
  const [validationState, setValidationState] = useState(null); // null | 'validating' | 'invalid' | 'duplicate'
  const [addError, setAddError]               = useState(null);
  const [showLimitModal, setShowLimitModal]   = useState(false);
  const [assetCount, setAssetCount]           = useState({ count: 0, limit: 5, remaining: 5 });
  const [lastApiCall, setLastApiCall]         = useState(null);

  const fetchAssetCount = useCallback(async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/user/assets/count', token);
      setAssetCount(data);
    } catch {}
  }, [getToken]);

  const fetchApiStatus = useCallback(async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/health/datasources', token);
      const calls = Object.values(data.sources ?? {}).map(s => s.lastCall).filter(Boolean);
      if (calls.length > 0) setLastApiCall(Math.max(...calls));
    } catch {}
  }, [getToken]);

  useEffect(() => { fetchAssetCount(); }, [fetchAssetCount, assets]);

  useEffect(() => {
    fetchApiStatus();
    const iv = setInterval(fetchApiStatus, 60_000);
    return () => clearInterval(iv);
  }, [fetchApiStatus]);

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
      await addAsset(data.symbol ?? symbol, data.symbol ?? symbol, data.asset_type ?? 'forex');
      setValidationState(null);
      setQuery('');
      fetchAssetCount();
    } catch (e) {
      setValidationState(null);
      if (e.message === 'asset_limit_reached') {
        setShowLimitModal(true);
      } else {
        setAddError(e.message);
      }
    }
  }

  return (
    <div className="shell">
      <div className="search-bar">
        <div className="search-input-wrap">
          <input
            className="search-input"
            placeholder="Enter symbol — EURUSD, XAU/USD, NIFTY, BTC/USD…"
            value={query}
            onChange={e => { setQuery(e.target.value); setValidationState(null); setAddError(null); }}
            onKeyDown={e => e.key === 'Enter' && handleAddAsset()}
            disabled={validationState === 'validating' || assetCount.remaining === 0}
          />
          <button
            className="search-btn"
            onClick={handleAddAsset}
            disabled={validationState === 'validating' || !query.trim() || assetCount.remaining === 0}
          >
            {validationState === 'validating' ? '…' : 'Add'}
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
          <span className="text-mono text-muted">
            {assetCount.count} / {assetCount.limit} assets used
            {assetCount.remaining === 0 && ' — limit reached'}
          </span>
          {lastApiCall && (
            <span className="text-mono text-muted" style={{ fontSize: 11 }}>
              Last call: {fmtTZ(lastApiCall, 'America/New_York', 'en-US')} NY
              {' · '}{fmtTZ(lastApiCall, 'Asia/Kolkata', 'en-IN')} IST
            </span>
          )}
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
              Your EBP Tracker subscription has expired. Contact the admin to renew your plan.
            </p>
          </div>
        </div>
      )}

      <ApiErrorAlert error={error} />

      {/* Forex & Crypto */}
      <div className="section-heading">Forex &amp; Crypto</div>

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
            onRemove={async (id) => { await removeAsset(id); fetchAssetCount(); }}
          />
        ))
      )}

      {/* NSE Market */}
      <div className="section-heading" style={{ marginTop: 24 }}>NSE Market</div>
      <div className="card" style={{ textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🇮🇳</div>
        <div className="card-title" style={{ borderBottom: 'none', paddingBottom: 0 }}>Indian share market alerts</div>
        <p className="text-muted" style={{ fontSize: 13, margin: '6px 0 16px' }}>
          NSE and BSE stocks, indices and more
        </p>
        <button className="btn btn-outline" disabled>Add Share Market Asset</button>
      </div>

      {showLimitModal && (
        <div className="modal-overlay" onClick={() => setShowLimitModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Asset Limit Reached</div>
            <div className="modal-body">
              <p>You have reached the maximum of {assetCount.limit} assets.</p>
              <p className="mt-md">
                To add more assets, please contribute a minimum of <strong>$15.00</strong> towards server upkeep and maintenance.
              </p>
              <p className="mt-md">
                Contact the server admin for payment details.
              </p>
            </div>
            <button className="modal-close-btn" onClick={() => setShowLimitModal(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
