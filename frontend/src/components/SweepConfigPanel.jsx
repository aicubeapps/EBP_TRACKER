import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { SWEEP_TFS, NSE_SWEEP_TFS, BIAS_SOURCE_FRONTEND, NSE_BIAS_SOURCE_FRONTEND } from '../lib/constants';
import { capitalise } from '../lib/utils';

const ALERT_MODES = [
  { value: 'aligned',      label: 'Aligned' },
  { value: 'price_action', label: 'Price Action' },
  { value: 'all',          label: 'All' },
];

export default function SweepConfigPanel({ assetId, assetType, allowedTfs, biasCache }) {
  const { getToken } = useAuth();
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const fullTfOptions = assetType === 'nse' ? NSE_SWEEP_TFS : SWEEP_TFS;
  // allowedTfs is null while /user/me hasn't resolved yet — skip filtering rather
  // than showing a false "no timeframes enabled" state.
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
    } catch (e) {
      setError(e.message || 'Could not add sweep alert.');
    }
  }

  async function updateConfig(id, field, value) {
    const token = await getToken();
    await api.patch(`/user/sweep-configs/${id}`, { [field]: value }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  }

  async function deleteConfig(id) {
    const token = await getToken();
    await api.delete(`/user/sweep-configs/${id}`, token);
    setConfigs(prev => prev.filter(c => c.id !== id));
  }

  if (loading) return <div className="config-panel"><span className="spinner" /></div>;

  return (
    <div className="config-panel">
      {configs.length === 0 && (
        <p className="text-muted mb-sm">No sweep alert timeframes configured.</p>
      )}
      {error && <p className="mb-sm" style={{ fontSize: 12, color: 'var(--bear)' }}>{error}</p>}
      {configs.map(cfg => {
        const biasTF   = biasSource[cfg.timeframe] ?? null;
        const biasData = biasTF ? biasCache?.[biasTF] : null;
        const bias     = biasData?.bias ?? 'neutral';

        return (
          <div key={cfg.id} className="config-row">
            <select className="select-sm" value={cfg.timeframe}
              onChange={e => updateConfig(cfg.id, 'timeframe', e.target.value)}>
              {tfOptions.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <select className="select-sm" value={cfg.alert_mode}
              onChange={e => updateConfig(cfg.id, 'alert_mode', e.target.value)}>
              {ALERT_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            {biasTF && (
              <span className="bias-label">Bias: {capitalise(bias)} ({biasTF})</span>
            )}
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
