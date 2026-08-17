import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { FOREX_SMA_TFS, FOREX_SMA_HTF_OPTIONS } from '../lib/constants';

export default function ForexSmaConfigPanel({ assetId, allowedTfs, onToast }) {
  const { getToken } = useAuth();
  const [configs, setConfigs]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const toastTimerRef                 = useRef(null);

  // allowedTfs is null while /user/me hasn't resolved yet — skip filtering
  // rather than showing a false "no timeframes enabled" state.
  const tfOptions = allowedTfs ? FOREX_SMA_TFS.filter(tf => allowedTfs.includes(tf)) : FOREX_SMA_TFS;
  const availableTfs = tfOptions.filter(tf => !configs.some(c => c.timeframe === tf));

  const [pendingTf, setPendingTf]                             = useState(availableTfs[0] ?? tfOptions[0]);
  const [pendingBiasMode, setPendingBiasMode]                 = useState('ttrades');
  const [pendingHtfTf, setPendingHtfTf]                       = useState(FOREX_SMA_HTF_OPTIONS[pendingTf]?.[0] ?? '4H');
  const [pendingConfirmationMode, setPendingConfirmationMode] = useState('either');

  const fetchConfigs = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get(`/user/forex-indicator-configs/${assetId}`, token);
    setConfigs(Array.isArray(data) ? data : []);
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

  async function addConfig() {
    setError(null);
    try {
      const token = await getToken();
      const res   = await api.post(`/user/forex-indicator-configs/${assetId}`, {
        timeframe: pendingTf, bias_mode: pendingBiasMode,
        htf_timeframe: pendingHtfTf, confirmation_mode: pendingConfirmationMode,
      }, token);
      setConfigs(prev => [...prev, {
        id: res.id, indicator: 'sma', timeframe: pendingTf,
        bias_mode: pendingBiasMode, htf_timeframe: pendingHtfTf,
        confirmation_mode: pendingConfirmationMode, enabled: 1,
      }]);
      setShowAddForm(false);
      onToast?.('✓ Alert Added', 'add');
    } catch (e) {
      setError(e.message || 'Could not add SMA alert.');
    }
  }

  async function updateConfig(id, field, value) {
    const token = await getToken();
    await api.patch(`/user/forex-indicator-configs/${id}`, { [field]: value }, token);
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
    fireReConfigToast();
  }

  async function deleteConfig(id) {
    const token = await getToken();
    await api.delete(`/user/forex-indicator-configs/${id}`, token);
    setConfigs(prev => prev.filter(c => c.id !== id));
    onToast?.('✕ Alert Removed', 'remove');
  }

  function onPendingTfChange(tf) {
    setPendingTf(tf);
    setPendingHtfTf(FOREX_SMA_HTF_OPTIONS[tf]?.[0] ?? '4H');
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
            <select className="select-sm" value={cfg.htf_timeframe ?? FOREX_SMA_HTF_OPTIONS[cfg.timeframe]?.[0]}
              onChange={e => updateConfig(cfg.id, 'htf_timeframe', e.target.value)}>
              {(FOREX_SMA_HTF_OPTIONS[cfg.timeframe] ?? []).map(tf => (
                <option key={tf} value={tf}>HTF: {tf === 'D' ? 'Daily' : tf}</option>
              ))}
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
            <select className="select-sm" value={pendingTf} onChange={e => onPendingTfChange(e.target.value)}>
              {availableTfs.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <select className="select-sm" value={pendingBiasMode} onChange={e => setPendingBiasMode(e.target.value)}>
              <option value="ttrades">HTF TTrades bias</option>
              <option value="htf_sma">HTF SMA alignment</option>
              <option value="none">Same TF momentum only</option>
            </select>
            {pendingBiasMode !== 'none' && (
              <select className="select-sm" value={pendingHtfTf} onChange={e => setPendingHtfTf(e.target.value)}>
                {(FOREX_SMA_HTF_OPTIONS[pendingTf] ?? []).map(tf => (
                  <option key={tf} value={tf}>HTF: {tf === 'D' ? 'Daily' : tf}</option>
                ))}
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
          <button className="add-link" onClick={() => { onPendingTfChange(availableTfs[0]); setShowAddForm(true); }}>+ Add SMA Alert</button>
        )
      )}
    </div>
  );
}
