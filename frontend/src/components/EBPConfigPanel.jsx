import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { EBP_TFS, NSE_EBP_TFS, BIAS_SOURCE_FRONTEND, NSE_BIAS_SOURCE_FRONTEND } from '../lib/constants';
import { capitalise } from '../lib/utils';

const ALERT_MODES = [
  { value: 'aligned',      label: 'Aligned' },
  { value: 'price_action', label: 'Price Action' },
  { value: 'all',          label: 'All' },
];

// Only 1H and 4H get a user-choosable HTF — M15/M30/D/W stay fixed to
// BIAS_SOURCE_FRONTEND's default. Values match the bias_cache key
// convention ('D'/'W'), same as biasSource's own values.
const HTF_OVERRIDE_OPTIONS = {
  '1H': [{ value: '4H', label: '4H' }, { value: 'D', label: 'Daily' }],
  '4H': [{ value: 'D',  label: 'Daily' }, { value: 'W', label: 'Weekly' }],
};

export default function EBPConfigPanel({ assetId, assetType, allowedTfs, biasCache }) {
  const { getToken } = useAuth();
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const fullTfOptions = assetType === 'nse' ? NSE_EBP_TFS : EBP_TFS;
  // allowedTfs is null while /user/me hasn't resolved yet — skip filtering rather
  // than showing a false "no timeframes enabled" state.
  const tfOptions  = allowedTfs ? fullTfOptions.filter(tf => allowedTfs.includes(tf)) : fullTfOptions;
  const biasSource = assetType === 'nse' ? NSE_BIAS_SOURCE_FRONTEND.ebp : BIAS_SOURCE_FRONTEND.ebp;

  const fetchConfigs = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get(`/user/ebp-configs/${assetId}`, token);
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
      const res   = await api.post(`/user/ebp-configs/${assetId}`, { timeframe: tf, alert_mode: 'aligned' }, token);
      setConfigs(prev => [...prev, { id: res.id, timeframe: tf, alert_mode: 'aligned', enabled: 1 }]);
    } catch (e) {
      setError(e.message || 'Could not add EBP alert.');
    }
  }

  async function updateConfig(id, field, value) {
    const token = await getToken();
    await api.patch(`/user/ebp-configs/${id}`, { [field]: value }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  }

  // TF change resets htf_override to null server-side (falls back to the
  // BIAS_SOURCE default) — mirror that locally so the HTF select doesn't
  // show a stale override for the old timeframe.
  async function updateTimeframe(id, newTf) {
    const token = await getToken();
    await api.patch(`/user/ebp-configs/${id}`, { timeframe: newTf }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, timeframe: newTf, htf_override: null } : c));
  }

  async function deleteConfig(id) {
    const token = await getToken();
    await api.delete(`/user/ebp-configs/${id}`, token);
    setConfigs(prev => prev.filter(c => c.id !== id));
  }

  if (loading) return <div className="config-panel"><span className="spinner" /></div>;

  return (
    <div className="config-panel">
      {configs.length === 0 && (
        <p className="text-muted mb-sm">No EBP alert timeframes configured.</p>
      )}
      {error && <p className="mb-sm" style={{ fontSize: 12, color: 'var(--bear)' }}>{error}</p>}
      {configs.map(cfg => {
        // htf_override, when set, is the TF actually in effect — not the
        // BIAS_SOURCE default. Both the label below and the HTF select's
        // pre-selected value must reflect whichever one is really active.
        const biasTF   = cfg.htf_override || (biasSource[cfg.timeframe] ?? null);
        const biasData = biasTF ? biasCache?.[biasTF] : null;
        const bias     = biasData?.bias ?? 'neutral';

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
                {HTF_OVERRIDE_OPTIONS[cfg.timeframe].map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
            {biasTF && (
              <span className="bias-label">Bias: {capitalise(bias)} ({biasTF})</span>
            )}
            <button className="icon-btn" onClick={() => deleteConfig(cfg.id)}>✕</button>
          </div>
        );
      })}
      {tfOptions.length > 0 ? (
        <button className="add-link" onClick={addConfig}>+ Add EBP Alert</button>
      ) : (
        <p className="text-muted" style={{ fontSize: 12 }}>No timeframes enabled for your account — contact admin.</p>
      )}
    </div>
  );
}
