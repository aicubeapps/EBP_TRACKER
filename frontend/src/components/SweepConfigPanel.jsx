import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { SWEEP_TFS, NSE_SWEEP_TFS, BIAS_SOURCE_FRONTEND, NSE_BIAS_SOURCE_FRONTEND, HTF_OVERRIDE_OPTIONS } from '../lib/constants';
import { capitalise } from '../lib/utils';

const ALERT_MODES = [
  { value: 'aligned',      label: 'Aligned' },
  { value: 'price_action', label: 'Price Action' },
  { value: 'all',          label: 'All' },
];

// override-or-raw chooser, mirrors the backend's getEffectiveBias but
// against biasCache — the object GET /user/bias/:symbol returns, keyed by
// timeframe ({ [tf]: { bias, updated_at } }) — not a {timeframe,bias}[] array.
function getEffectiveBiasDisplay(htfTf, biasCache, biasOverrides) {
  const override = biasOverrides?.[htfTf];
  const raw = biasCache?.[htfTf]?.bias ?? '—';
  if (override && override !== 'auto') {
    return { label: override, isOverridden: true, raw };
  }
  return { label: raw, isOverridden: false, raw: null };
}

export default function SweepConfigPanel({ assetId, assetType, allowedTfs, biasCache, biasOverrides, onUpdate }) {
  const { getToken } = useAuth();
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const fullTfOptions = assetType === 'nse' ? NSE_SWEEP_TFS : SWEEP_TFS;
  const tfOptions  = allowedTfs ? fullTfOptions.filter(tf => allowedTfs.includes(tf)) : fullTfOptions;
  const biasSource = assetType === 'nse' ? NSE_BIAS_SOURCE_FRONTEND.sweep : BIAS_SOURCE_FRONTEND.sweep;

  const fetchConfigs = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get(`/user/sweep-configs/${assetId}`, token);
    setConfigs(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [assetId, getToken]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  async function addConfig() {
    const tf = tfOptions.find(t => !configs.some(c => c.timeframe === t)) ?? tfOptions[0];
    if (!tf) return;
    setError(null);
    try {
      const token = await getToken();
      const res   = await api.post(`/user/sweep-configs/${assetId}`, { timeframe: tf, alert_mode: 'aligned' }, token);
      setConfigs(prev => [...prev, { id: res.id, timeframe: tf, alert_mode: 'aligned', enabled: 1 }]);
      onUpdate?.();
    } catch (e) {
      setError(e.message || 'Could not add sweep alert.');
    }
  }

  async function updateConfig(id, field, value) {
    const token = await getToken();
    await api.patch(`/user/sweep-configs/${id}`, { [field]: value }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
    onUpdate?.();
  }

  async function updateTimeframe(id, newTf) {
    const token = await getToken();
    await api.patch(`/user/sweep-configs/${id}`, { timeframe: newTf }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, timeframe: newTf, htf_override: null } : c));
    onUpdate?.();
  }

  async function deleteConfig(id) {
    const token = await getToken();
    await api.delete(`/user/sweep-configs/${id}`, token);
    setConfigs(prev => prev.filter(c => c.id !== id));
    onUpdate?.();
  }

  if (loading) return <div className="config-panel"><span className="spinner" /></div>;

  return (
    <div className="config-panel">
      {configs.length === 0 && (
        <p className="text-muted mb-sm">No sweep alert timeframes configured.</p>
      )}
      {error && <p className="mb-sm" style={{ fontSize: 12, color: 'var(--bear)' }}>{error}</p>}
      {configs.map(cfg => {
        const biasTF      = cfg.htf_override || (biasSource[cfg.timeframe] ?? null);
        const biasDisplay = biasTF ? getEffectiveBiasDisplay(biasTF, biasCache, biasOverrides) : null;

        return (
          <div key={cfg.id} className="config-row">
            <select className="select-sm" value={cfg.timeframe}
              onChange={e => updateTimeframe(cfg.id, e.target.value)}>
              {tfOptions.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <select className="select-sm" value={cfg.alert_mode}
              onChange={e => updateConfig(cfg.id, 'alert_mode', e.target.value)}>
              {ALERT_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            {HTF_OVERRIDE_OPTIONS[cfg.timeframe] && (
              <select className="select-sm" value={biasTF}
                onChange={e => updateConfig(cfg.id, 'htf_override', e.target.value)}>
                {HTF_OVERRIDE_OPTIONS[cfg.timeframe].map(tf => (
                  <option key={tf} value={tf}>{tf === 'D' ? 'Daily' : tf === 'W' ? 'Weekly' : tf}</option>
                ))}
              </select>
            )}
            {biasDisplay && (
              <span className={biasDisplay.isOverridden ? 'bias-overridden' : 'bias-auto'}>
                Bias: {capitalise(biasDisplay.label)} ({biasTF})
                {biasDisplay.isOverridden && (
                  <span className="bias-raw"> · Market: {capitalise(biasDisplay.raw)}</span>
                )}
              </span>
            )}
            <select className="select-sm" value={cfg.enabled ? '1' : '0'}
              onChange={e => updateConfig(cfg.id, 'enabled', e.target.value === '1' ? 1 : 0)}>
              <option value="1">Enabled</option>
              <option value="0">Disabled</option>
            </select>
            <button className="icon-btn" onClick={() => deleteConfig(cfg.id)}>✕</button>
          </div>
        );
      })}
      {tfOptions.length > 0 ? (
        <button className="add-link" onClick={addConfig}>+ Add Sweep Alert</button>
      ) : (
        <p className="text-muted" style={{ fontSize: 12 }}>No timeframes enabled for your account — contact admin.</p>
      )}
    </div>
  );
}
