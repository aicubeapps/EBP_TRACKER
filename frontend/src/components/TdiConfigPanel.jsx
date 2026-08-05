import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { TDI_TFS } from '../lib/constants';

export default function TdiConfigPanel({ assetId, allowedTfs, onUpdate }) {
  const { getToken } = useAuth();
  const [configs, setConfigs]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [pendingTf, setPendingTf]     = useState(TDI_TFS[0]);

  const fetchConfigs = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get(`/user/nse-indicator-configs/${assetId}`, token);
    setConfigs(Array.isArray(data) ? data.filter(c => c.indicator === 'tdi') : []);
    setLoading(false);
  }, [assetId, getToken]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  // allowedTfs is null while /user/me hasn't resolved yet — skip filtering
  // rather than showing a false "no timeframes enabled" state.
  const visibleTfs   = TDI_TFS.filter(tf => !allowedTfs || allowedTfs.includes(tf));
  const availableTfs = visibleTfs.filter(tf => !configs.some(c => c.timeframe === tf));

  async function addConfig() {
    setError(null);
    try {
      const token = await getToken();
      const res   = await api.post(`/user/nse-indicator-configs/${assetId}`, { indicator: 'tdi', timeframe: pendingTf }, token);
      setConfigs(prev => [...prev, { id: res.id, indicator: 'tdi', timeframe: pendingTf, enabled: 1 }]);
      setShowAddForm(false);
      onUpdate?.();
    } catch (e) {
      setError(e.message || 'Could not add TDI alert.');
    }
  }

  async function updateConfig(id, field, value) {
    const token = await getToken();
    await api.patch(`/user/nse-indicator-configs/${id}`, { [field]: value }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
    onUpdate?.();
  }

  async function deleteConfig(id) {
    const token = await getToken();
    await api.delete(`/user/nse-indicator-configs/${id}`, token);
    setConfigs(prev => prev.filter(c => c.id !== id));
    onUpdate?.();
  }

  if (loading) return <div className="config-panel"><span className="spinner" /></div>;

  return (
    <div className="config-panel">
      {configs.length === 0 && (
        <p className="text-muted mb-sm">No TDI alert timeframes configured.</p>
      )}
      {error && <p className="mb-sm" style={{ fontSize: 12, color: 'var(--bear)' }}>{error}</p>}
      {configs.map(cfg => (
        <div key={cfg.id} className="config-row">
          <span className="text-mono" style={{ fontSize: 12 }}>{cfg.timeframe}</span>
          <select className="select-sm" value={cfg.enabled ? '1' : '0'}
            onChange={e => updateConfig(cfg.id, 'enabled', e.target.value === '1' ? 1 : 0)}>
            <option value="1">Enabled</option>
            <option value="0">Disabled</option>
          </select>
          <button className="icon-btn" onClick={() => deleteConfig(cfg.id)}>✕</button>
        </div>
      ))}
      {availableTfs.length > 0 && (
        showAddForm ? (
          <div className="config-row">
            <select className="select-sm" value={pendingTf} onChange={e => setPendingTf(e.target.value)}>
              {availableTfs.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <button className="add-link" onClick={addConfig}>Add</button>
          </div>
        ) : (
          <button className="add-link" onClick={() => { setPendingTf(availableTfs[0]); setShowAddForm(true); }}>+ Add TDI Alert</button>
        )
      )}
    </div>
  );
}
