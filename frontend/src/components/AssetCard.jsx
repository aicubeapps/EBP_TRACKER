import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { fmtNY } from '../lib/utils';
import EBPConfigPanel from './EBPConfigPanel';
import SweepConfigPanel from './SweepConfigPanel';
import AIAlertsPanel from './AIAlertsPanel';
import BiasOverridePanel from './BiasOverridePanel';

export default function AssetCard({ asset, allowedTfs, onRemove }) {
  const { getToken } = useAuth();
  const navigate     = useNavigate();

  const [ebpEnabled,   setEbpEnabled]   = useState(false);
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [aiEnabled,    setAiEnabled]    = useState(false);
  const [showBiasOverride, setShowBiasOverride] = useState(false);
  const [biasOverrides, setBiasOverrides] = useState(() => {
    try { return JSON.parse(asset.bias_overrides || '{}'); } catch { return {}; }
  });
  const [lastAlert, setLastAlert] = useState(null);
  const [biasCache, setBiasCache] = useState({});

  const fetchSummary = useCallback(async () => {
    const token = await getToken();
    const [ebp, swp, tmpl, hist, bias] = await Promise.allSettled([
      api.get(`/user/ebp-configs/${asset.id}`, token),
      api.get(`/user/sweep-configs/${asset.id}`, token),
      api.get(`/user/templates/${asset.id}`, token),
      api.get(`/alerts/history?assetId=${asset.id}&days=2&limit=1`, token),
      api.get(`/user/bias/${encodeURIComponent(asset.symbol)}`, token),
    ]);
    if (ebp.status === 'fulfilled')  setEbpEnabled(Array.isArray(ebp.value) && ebp.value.length > 0);
    if (swp.status === 'fulfilled')  setSweepEnabled(Array.isArray(swp.value) && swp.value.length > 0);
    if (tmpl.status === 'fulfilled') setAiEnabled(Array.isArray(tmpl.value) && tmpl.value.some(t => t.enabled));
    if (hist.status === 'fulfilled' && Array.isArray(hist.value) && hist.value.length > 0)
      setLastAlert(hist.value[0]);
    if (bias.status === 'fulfilled') setBiasCache(bias.value ?? {});
  }, [asset.id, asset.symbol, getToken]);

  useEffect(() => {
    fetchSummary();
    const id = setInterval(fetchSummary, 60000);
    return () => clearInterval(id);
  }, [fetchSummary]);

  const handleOverrideChange = async (tf, value) => {
    const updated = { ...biasOverrides, [tf]: value };
    setBiasOverrides(updated);
    const token = await getToken();
    await api.patch(`/user/assets/${asset.id}/bias-overrides`, { bias_overrides: updated }, token);
  };

  const assetTypeBadge = (asset.asset_type ?? 'forex').toLowerCase().replace(/\s/g, '_');

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{asset.symbol}</span>
        <span className={`badge badge-${assetTypeBadge}`}>{asset.asset_type?.replace('_', ' ')}</span>
        <button className="card-remove-btn" onClick={() => onRemove(asset.id)} title="Remove">✕</button>
      </div>

      {lastAlert && (
        <p className="text-muted mb-md" style={{ cursor: 'pointer', marginTop: -8 }} onClick={() => navigate('/alerts')}>
          Last: {lastAlert.direction.toUpperCase()} {lastAlert.alert_type.toUpperCase()} {lastAlert.timeframe} — {fmtNY(lastAlert.fired_at)}
        </p>
      )}

      {/* EBP Alerts */}
      <div className="check-row">
        <input type="checkbox" id={`ebp-${asset.id}`}
          checked={ebpEnabled} onChange={e => setEbpEnabled(e.target.checked)} />
        <label htmlFor={`ebp-${asset.id}`}>EBP Alerts</label>
        {ebpEnabled && (
          <button className="override-btn" onClick={() => setShowBiasOverride(o => !o)}>
            {showBiasOverride ? 'Hide' : 'Override'} Bias
          </button>
        )}
      </div>
      {ebpEnabled && showBiasOverride && (
        <BiasOverridePanel overrides={biasOverrides} onChange={handleOverrideChange} />
      )}
      {ebpEnabled && <EBPConfigPanel assetId={asset.id} assetType={asset.asset_type} allowedTfs={allowedTfs} biasCache={biasCache} />}

      {/* Sweep Alerts */}
      <div className="check-row">
        <input type="checkbox" id={`sweep-${asset.id}`}
          checked={sweepEnabled} onChange={e => setSweepEnabled(e.target.checked)} />
        <label htmlFor={`sweep-${asset.id}`}>Sweep Alerts</label>
      </div>
      {sweepEnabled && <SweepConfigPanel assetId={asset.id} assetType={asset.asset_type} allowedTfs={allowedTfs} biasCache={biasCache} />}

      {/* AI Alerts */}
      <div className="check-row">
        <input type="checkbox" id={`ai-${asset.id}`}
          checked={aiEnabled} onChange={e => setAiEnabled(e.target.checked)} />
        <label htmlFor={`ai-${asset.id}`}>AI Alerts</label>
      </div>
      {aiEnabled && <AIAlertsPanel assetId={asset.id} />}
    </div>
  );
}
