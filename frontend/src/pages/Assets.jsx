import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useAssets } from '../hooks/useAssets';
import { FOREX_SECTIONS, CRYPTO_PAIRS } from '../data/assetLists';
import NseSearchModal from '../components/NseSearchModal';
import api from '../lib/api';

export default function Assets() {
  const { getToken } = useAuth();
  const { assets, loading, addAsset, removeAsset, refetch } = useAssets();

  const [assetCount, setAssetCount]           = useState({
    forex_crypto_count: 0, forex_crypto_limit: 5, forex_crypto_remaining: 5,
    nse_count: 0, nse_limit: 'unlimited',
  });
  const [countLoading, setCountLoading]       = useState(true);
  const [pending, setPending]                 = useState({});
  const [rowErrors, setRowErrors]             = useState({});
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [showNseModal, setShowNseModal]       = useState(false);
  const [toast, setToast]                     = useState(null);

  const fetchCount = useCallback(async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/user/assets/count', token);
      setAssetCount(data);
    } catch {} finally {
      setCountLoading(false);
    }
  }, [getToken]);

  useEffect(() => { fetchCount(); }, [fetchCount, assets]);

  const ownedMap = {};
  for (const a of assets) ownedMap[a.symbol] = a.id;

  const limitReached = assetCount.forex_crypto_count >= assetCount.forex_crypto_limit;

  async function handleToggle(symbol, assetType, checked) {
    setPending(p => ({ ...p, [symbol]: true }));
    setRowErrors(p => ({ ...p, [symbol]: undefined }));
    try {
      if (checked) {
        await addAsset(symbol, symbol, assetType);
      } else {
        await removeAsset(ownedMap[symbol]);
      }
    } catch (e) {
      setRowErrors(p => ({ ...p, [symbol]: 'Failed — try again' }));
    } finally {
      setPending(p => ({ ...p, [symbol]: false }));
    }
  }

  function renderCheckbox(symbol, assetType) {
    const isOwned   = !!ownedMap[symbol];
    const isPending = !!pending[symbol];
    const isLocked  = limitReached && !isOwned;
    const rowError  = rowErrors[symbol];

    return (
      <div className="asset-check-wrap" key={symbol}>
        <label className={`asset-check-row ${isPending ? 'pending' : ''} ${isLocked ? 'locked' : ''}`}>
          <input
            type="checkbox"
            checked={isOwned}
            disabled={isPending || isLocked}
            onChange={e => handleToggle(symbol, assetType, e.target.checked)}
          />
          <span>{symbol}</span>
          {isLocked && <span style={{ marginLeft: 'auto' }}>🔒</span>}
        </label>
        {rowError && <span className="asset-check-error">{rowError}</span>}
      </div>
    );
  }

  function handleNseAdded(symbol) {
    refetch();
    setToast(`${symbol} added to your watchlist`);
    setTimeout(() => setToast(null), 2500);
  }

  const isLoading = loading || countLoading;

  return (
    <div className="shell">
      <div className="page-title">Assets</div>

      {limitReached && !bannerDismissed && (
        <div className="asset-limit-banner">
          <span>Pay $30.00 to unlock more assets. This is for server maintenance and data access.</span>
          <button onClick={() => setBannerDismissed(true)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {isLoading ? (
        <>
          {[1, 2, 3].map(i => (
            <div key={i} className="card">
              <div className="skeleton" style={{ width: 120, height: 16, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: '100%', height: 60 }} />
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="section-heading">Forex</div>
          {FOREX_SECTIONS.map(section => (
            <div key={section.label}>
              <div className="asset-sub-header">{section.label}</div>
              <div className="asset-grid">
                {section.pairs.map(symbol => renderCheckbox(symbol, 'forex'))}
              </div>
            </div>
          ))}

          <div className="section-heading" style={{ marginTop: 24 }}>Crypto</div>
          <div className="asset-grid">
            {CRYPTO_PAIRS.map(symbol => renderCheckbox(symbol, 'crypto'))}
          </div>

          <div className="section-heading" style={{ marginTop: 24 }}>NSE / Indian Markets</div>
          <div className="card" style={{ textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🇮🇳</div>
            <div className="card-title" style={{ borderBottom: 'none', paddingBottom: 0 }}>Indian share market alerts</div>
            <p className="text-muted" style={{ fontSize: 13, margin: '6px 0 16px' }}>
              NSE and BSE stocks, indices and ETFs — no slot limit
            </p>
            <button className="btn btn-outline" onClick={() => setShowNseModal(true)}>Add Share Market Asset</button>
          </div>
        </>
      )}

      <NseSearchModal
        isOpen={showNseModal}
        onClose={() => setShowNseModal(false)}
        onAdded={handleNseAdded}
      />

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--nav-bg)', color: '#f1f5f9', padding: '10px 20px',
          borderRadius: 'var(--radius-md)', fontSize: 13, fontFamily: 'var(--font-mono)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)', zIndex: 2000,
        }}>
          ✓ {toast}
        </div>
      )}
    </div>
  );
}
