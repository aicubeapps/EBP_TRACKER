import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { useAssets } from '../hooks/useAssets';
import { useUser } from '../hooks/useUser';
import ApiErrorAlert from '../components/ApiErrorAlert';
import AssetCard from '../components/AssetCard';
import api from '../lib/api';

export default function Dashboard() {
  const navigate      = useNavigate();
  const { getToken }  = useAuth();
  const { user }                                          = useUser();
  const { assets, loading, error, removeAsset }           = useAssets();

  const [assetCount, setAssetCount]     = useState({
    forex_crypto_count: 0, forex_crypto_limit: 5, forex_crypto_remaining: 5,
    nse_count: 0, nse_limit: 'unlimited',
  });
  const [upstoxConfigured, setUpstoxConfigured] = useState(true); // assume configured until checked, avoids a flash of the delay badge

  const fetchAssetCount = useCallback(async () => {
    try {
      const token = await getToken();
      const data  = await api.get('/user/assets/count', token);
      setAssetCount(data);
    } catch {}
  }, [getToken]);

  useEffect(() => { fetchAssetCount(); }, [fetchAssetCount, assets]);

  useEffect(() => {
    // Public route — no token needed, works for non-admin users too.
    api.get('/nse/status').then(data => setUpstoxConfigured(!!data?.upstox_configured)).catch(() => {});
  }, []);

  const forexCryptoAssets = assets.filter(a => a.asset_type === 'forex' || a.asset_type === 'crypto');
  const nseAssets         = assets.filter(a => a.asset_type === 'nse');

  // null = still loading / not yet known — panels skip filtering rather than
  // showing a false "no timeframes enabled" state before /user/me resolves.
  const parseTfList = (raw) => {
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const userTfAccess    = parseTfList(user?.user_tf_access);
  const userNseTfAccess = parseTfList(user?.nse_tf_access);

  return (
    <div className="shell">
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div className="section-heading" style={{ marginBottom: 0 }}>Forex &amp; Crypto</div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate('/assets')}>+ Add Asset</button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4, margin: '6px 0 var(--sp-md)' }}>
        <span className="text-mono text-muted" style={{ fontSize: 11 }}>
          {assetCount.forex_crypto_count} / {assetCount.forex_crypto_limit} assets used
          {assetCount.forex_crypto_remaining === 0 && ' — limit reached'}
        </span>
      </div>

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
      ) : forexCryptoAssets.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p className="text-muted" style={{ fontSize: 13 }}>
            No assets yet — tap "+ Add Asset" above to add your first asset
          </p>
        </div>
      ) : (
        forexCryptoAssets.map(asset => (
          <AssetCard
            key={asset.id}
            asset={asset}
            allowedTfs={asset.asset_type === 'nse' ? userNseTfAccess : userTfAccess}
            onRemove={async (id) => { await removeAsset(id); fetchAssetCount(); }}
          />
        ))
      )}

      {/* NSE Market */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 24 }}>
        <div className="section-heading" style={{ marginBottom: 0 }}>NSE Market</div>
        {!upstoxConfigured && (
          <span className="badge" style={{ background: 'var(--gold-lt)', color: 'var(--gold)' }}>~15 min delayed</span>
        )}
      </div>

      {!loading && nseAssets.length > 0 && nseAssets.map(asset => (
        <AssetCard
          key={asset.id}
          asset={asset}
          tier={user?.plan ?? 'free'}
          onRemove={async (id) => { await removeAsset(id); fetchAssetCount(); }}
        />
      ))}

      <div className="card" style={{ textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🇮🇳</div>
        <div className="card-title" style={{ borderBottom: 'none', paddingBottom: 0 }}>Indian share market alerts</div>
        <p className="text-muted" style={{ fontSize: 13, margin: '6px 0 16px' }}>
          NSE and BSE stocks, indices and more
        </p>
        <button className="btn btn-outline" onClick={() => navigate('/assets')}>Add Share Market Asset</button>
      </div>
    </div>
  );
}
