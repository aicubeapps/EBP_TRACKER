import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useAssets } from '../hooks/useAssets';
import { FOREX_SECTIONS, CRYPTO_PAIRS } from '../data/assetLists';
import api from '../lib/api';

export default function Assets() {
  const { getToken } = useAuth();
  const { assets, loading, addAsset, removeAsset } = useAssets();

  const [assetCount, setAssetCount]           = useState({ count: 0, limit: 5 });
  const [countLoading, setCountLoading]       = useState(true);
  const [pending, setPending]                 = useState({});
  const [rowErrors, setRowErrors]             = useState({});
  const [bannerDismissed, setBannerDismissed] = useState(false);

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

  const limitReached = assetCount.count >= assetCount.limit;

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
        </>
      )}
    </div>
  );
}
