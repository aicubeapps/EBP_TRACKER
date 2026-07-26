import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';

const SMA_TFS = ['M15', 'M5'];

export default function SmaConfigPanel({ assetId }) {
  const { getToken } = useAuth();
  const [configs, setConfigs]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [pendingTf, setPendingTf]         = useState(SMA_TFS[0]);
  const [pendingStack, setPendingStack]   = useState('strict');
  const [pendingDayFilter, setPendingDayFilter] = useState(1);

  const fetchConfigs = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get(`/user/nse-indicator-configs/${assetId}`, token);
    setConfigs(Array.isArray(data) ? data.filter(c => c.indicator === 'sma') : []);
    setLoading(false);
  }, [assetId, getToken]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  const availableTfs = SMA_TFS.filter(tf => !configs.some(c => c.timeframe === tf));

  async function addConfig() {
    setError(null);
    try {
      const token = await getToken();
      const res   = await api.post(`/user/nse-indicator-configs/${assetId}`, {
        indicator: 'sma', timeframe: pendingTf, stack_mode: pendingStack, day_filter: pendingDayFilter,
      }, token);
      setConfigs(prev => [...prev, {
        id: res.id, indicator: 'sma', timeframe: pendingTf,
        stack_mode: pendingStack, day_filter: pendingDayFilter, enabled: 1,
      }]);
      setShowAddForm(false);
    } catch (e) {
      setError(e.message || 'Could not add SMA alert.');
    }
  }

  async function updateConfig(id, field, value) {
    const token = await getToken();
    await api.patch(`/user/nse-indicator-configs/${id}`, { [field]: value }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  }

  async function deleteConfig(id) {
    const token = await getToken();
    await api.delete(`/user/nse-indicator-configs/${id}`, token);
    setConfigs(prev => prev.filter(c => c.id !== id));
  }

  if (loading) return <div className="config-panel"><span className="spinner" /></div>;

  return (
    <div className="config-panel">
      {configs.length === 0 && (
        <p className="text-muted mb-sm">No SMA Cloud alert timeframes configured.</p>
      )}
      {error && <p className="mb-sm" style={{ fontSize: 12, color: 'var(--bear)' }}>{error}</p>}
      {configs.map(cfg => (
        <div key={cfg.id} className="config-row">
          <span className="text-mono" style={{ fontSize: 12 }}>{cfg.timeframe}</span>
          <select className="select-sm" value={cfg.stack_mode ?? 'strict'}
            onChange={e => updateConfig(cfg.id, 'stack_mode', e.target.value)}>
            <option value="strict">Strict</option>
            <option value="loose">Loose</option>
          </select>
          <select className="select-sm" value={cfg.day_filter ?? 1}
            onChange={e => updateConfig(cfg.id, 'day_filter', Number(e.target.value))}>
            <option value={1}>Day filter: On</option>
            <option value={0}>Day filter: Off</option>
          </select>
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
            <select className="select-sm" value={pendingStack} onChange={e => setPendingStack(e.target.value)}>
              <option value="strict">Strict</option>
              <option value="loose">Loose</option>
            </select>
            <select className="select-sm" value={pendingDayFilter} onChange={e => setPendingDayFilter(Number(e.target.value))}>
              <option value={1}>Day filter: On</option>
              <option value={0}>Day filter: Off</option>
            </select>
            <button className="add-link" onClick={addConfig}>Add</button>
          </div>
        ) : (
          <button className="add-link" onClick={() => { setPendingTf(availableTfs[0]); setShowAddForm(true); }}>+ Add SMA Alert</button>
        )
      )}
    </div>
  );
}
