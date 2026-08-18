import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { NSE_SMA_TFS, NSE_SMA_HTF_TFS } from '../lib/constants';

export default function SmaConfigPanel({ assetId, allowedTfs, onUpdate, onToast }) {
  const { getToken } = useAuth();
  const [configs, setConfigs]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [pendingTf, setPendingTf]                     = useState(NSE_SMA_TFS[0]);
  const [pendingConfirmationMode, setPendingConfirmationMode] = useState('either');
  const [pendingHtfTf, setPendingHtfTf]               = useState(NSE_SMA_HTF_TFS[0]);
  const [pendingBiasMode, setPendingBiasMode]         = useState('ttrades');
  const toastTimerRef                                  = useRef(null);

  const fetchConfigs = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get(`/user/nse-indicator-configs/${assetId}`, token);
    setConfigs(Array.isArray(data) ? data.filter(c => c.indicator === 'sma') : []);
    setLoading(false);
  }, [assetId, getToken]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const fireReConfigToast = () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      onToast?.('✓ Re-Config Done', 'reconfig');
    }, 2000);
  };

  // allowedTfs is null while /user/me hasn't resolved yet — skip filtering
  // rather than showing a false "no timeframes enabled" state.
  const visibleTfs   = NSE_SMA_TFS.filter(tf => !allowedTfs || allowedTfs.includes(tf));
  const availableTfs = visibleTfs.filter(tf => !configs.some(c => c.timeframe === tf));

  async function addConfig() {
    setError(null);
    try {
      const token = await getToken();
      const res   = await api.post(`/user/nse-indicator-configs/${assetId}`, {
        indicator: 'sma', timeframe: pendingTf, confirmation_mode: pendingConfirmationMode,
        bias_mode: pendingBiasMode, htf_timeframe: pendingHtfTf,
      }, token);
      setConfigs(prev => [...prev, {
        id: res.id, indicator: 'sma', timeframe: pendingTf,
        confirmation_mode: pendingConfirmationMode, bias_mode: pendingBiasMode, htf_timeframe: pendingHtfTf, enabled: 1,
      }]);
      setShowAddForm(false);
      onToast?.('✓ Alert Added', 'add');
      onUpdate?.();
    } catch (e) {
      setError(e.message || 'Could not add SMA alert.');
    }
  }

  async function updateConfig(id, field, value) {
    const token = await getToken();
    await api.patch(`/user/nse-indicator-configs/${id}`, { [field]: value }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
    onUpdate?.();
    fireReConfigToast();
  }

  async function deleteConfig(id) {
    const token = await getToken();
    await api.delete(`/user/nse-indicator-configs/${id}`, token);
    setConfigs(prev => prev.filter(c => c.id !== id));
    onToast?.('✕ Alert Removed', 'remove');
    onUpdate?.();
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
          <select className="select-sm" value={cfg.bias_mode ?? 'ttrades'}
            onChange={e => updateConfig(cfg.id, 'bias_mode', e.target.value)}>
            <option value="ttrades">HTF TTrades bias</option>
            <option value="htf_sma">HTF SMA alignment</option>
            <option value="none">Same TF momentum only</option>
          </select>
          {cfg.bias_mode !== 'none' && (
            <select className="select-sm" value={cfg.htf_timeframe ?? NSE_SMA_HTF_TFS[0]}
              onChange={e => updateConfig(cfg.id, 'htf_timeframe', e.target.value)}>
              {NSE_SMA_HTF_TFS.map(tf => <option key={tf} value={tf}>HTF: {tf === 'D' ? 'Daily' : tf}</option>)}
            </select>
          )}
          <select className="select-sm" value={cfg.confirmation_mode ?? 'either'}
            onChange={e => updateConfig(cfg.id, 'confirmation_mode', e.target.value)}>
            <option value="either">Either (MSS or CISD)</option>
            <option value="mss">MSS only</option>
            <option value="cisd">CISD only</option>
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
            <select className="select-sm" value={pendingBiasMode} onChange={e => setPendingBiasMode(e.target.value)}>
              <option value="ttrades">HTF TTrades bias</option>
              <option value="htf_sma">HTF SMA alignment</option>
              <option value="none">Same TF momentum only</option>
            </select>
            {pendingBiasMode !== 'none' && (
              <select className="select-sm" value={pendingHtfTf} onChange={e => setPendingHtfTf(e.target.value)}>
                {NSE_SMA_HTF_TFS.map(tf => <option key={tf} value={tf}>HTF: {tf === 'D' ? 'Daily' : tf}</option>)}
              </select>
            )}
            <select className="select-sm" value={pendingConfirmationMode} onChange={e => setPendingConfirmationMode(e.target.value)}>
              <option value="either">Either (MSS or CISD)</option>
              <option value="mss">MSS only</option>
              <option value="cisd">CISD only</option>
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
