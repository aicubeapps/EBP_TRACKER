import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { fmtNY } from '../lib/utils';
import EBPConfigPanel from './EBPConfigPanel';
import SweepConfigPanel from './SweepConfigPanel';
import AIAlertsPanel from './AIAlertsPanel';
import BiasOverridePanel from './BiasOverridePanel';
import TdiConfigPanel from './TdiConfigPanel';
import SmaConfigPanel from './SmaConfigPanel';
import ForexSmaConfigPanel from './ForexSmaConfigPanel';
import { FVGZoneIndicator } from './FVGZoneIndicator';

export default function AssetCard({ asset, allowedTfs: allowedTfsProp, userNseTfAccess, onRemove }) {
  const { getToken } = useAuth();
  const navigate     = useNavigate();
  const isNse        = asset.asset_type === 'nse';
  const isForex      = ['forex', 'crypto', 'commodity'].includes(asset.asset_type);

  // NSE assets need nse_tf_access, not the forex/crypto user_tf_access;
  // fall back to allowedTfsProp in case a caller only sends that.
  const allowedTfs = isNse ? (userNseTfAccess ?? allowedTfsProp ?? null) : (allowedTfsProp ?? null);

  const [ebpEnabled,   setEbpEnabled]   = useState(false);
  const [sweepEnabled, setSweepEnabled] = useState(false);
  const [aiEnabled,    setAiEnabled]    = useState(false);
  const [tdiEnabled,   setTdiEnabled]   = useState(false);
  const [smaEnabled,   setSmaEnabled]   = useState(false);
  const [ebpConfigs,   setEbpConfigs]   = useState([]);
  const [sweepConfigs, setSweepConfigs] = useState([]);
  const [toast,        setToast]        = useState(null);
  const [showBiasOverride, setShowBiasOverride] = useState(false);
  const [biasOverrides, setBiasOverrides] = useState(() => {
    try { return JSON.parse(asset.bias_overrides || '{}'); } catch { return {}; }
  });
  const [lastAlert, setLastAlert]   = useState(null);
  const [biasCache, setBiasCache]   = useState({});
  const [chainStates, setChainStates] = useState([]);
  const [fvgZoneData, setFvgZoneData] = useState([]);

  const fetchSummary = useCallback(async () => {
    const token = await getToken();
    const [ebp, swp, tmpl, hist, bias, ind, forexSma, chains, fvgZones] = await Promise.allSettled([
      api.get(`/user/ebp-configs/${asset.id}`, token),
      api.get(`/user/sweep-configs/${asset.id}`, token),
      api.get(`/user/templates/${asset.id}`, token),
      api.get(`/alerts/history?assetId=${asset.id}&days=2&limit=1`, token),
      api.get(`/user/bias/${encodeURIComponent(asset.symbol)}`, token),
      isNse ? api.get(`/user/nse-indicator-configs/${asset.id}`, token) : Promise.resolve([]),
      isForex ? api.get(`/user/forex-indicator-configs/${asset.id}`, token) : Promise.resolve([]),
      // Templates/chains/FVG zones don't apply to NSE assets.
      (!isNse) ? api.get(`/user/chain-state/${asset.id}`, token) : Promise.resolve([]),
      (!isNse) ? api.get(`/user/fvg-zones/${asset.id}`, token) : Promise.resolve([]),
    ]);
    if (ebp.status === 'fulfilled') {
      setEbpConfigs(Array.isArray(ebp.value) ? ebp.value : []);
      setEbpEnabled(Array.isArray(ebp.value) && ebp.value.some(c => c.enabled === 1));
    }
    if (swp.status === 'fulfilled') {
      setSweepConfigs(Array.isArray(swp.value) ? swp.value : []);
      setSweepEnabled(Array.isArray(swp.value) && swp.value.some(c => c.enabled === 1));
    }
    if (tmpl.status === 'fulfilled') setAiEnabled(Array.isArray(tmpl.value) && tmpl.value.some(t => t.enabled));
    if (hist.status === 'fulfilled' && Array.isArray(hist.value) && hist.value.length > 0)
      setLastAlert(hist.value[0]);
    if (bias.status === 'fulfilled') setBiasCache(bias.value ?? {});
    if (ind.status === 'fulfilled' && Array.isArray(ind.value)) {
      setTdiEnabled(ind.value.some(c => c.indicator === 'tdi'));
      setSmaEnabled(ind.value.some(c => c.indicator === 'sma'));
    }
    if (forexSma.status === 'fulfilled' && Array.isArray(forexSma.value)) {
      setSmaEnabled(forexSma.value.length > 0);
    }
    if (chains.status === 'fulfilled') setChainStates(Array.isArray(chains.value) ? chains.value : []);
    if (fvgZones.status === 'fulfilled') setFvgZoneData(Array.isArray(fvgZones.value) ? fvgZones.value : []);
  }, [asset.id, asset.symbol, isNse, isForex, getToken]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const handleOverrideChange = async (tf, value) => {
    const updated = { ...biasOverrides, [tf]: value };
    setBiasOverrides(updated);
    const token = await getToken();
    await api.patch(`/user/assets/${asset.id}/bias-overrides`, { bias_overrides: updated }, token);
  };

  const assetTypeBadge = (asset.asset_type ?? 'forex').toLowerCase().replace(/\s/g, '_');

  // DXY (asset_type 'system') isn't forex/crypto/commodity but does support
  // EBP bias-override, FVG zones and AI Alerts — gate on !isNse (matches
  // the fetch gates above), not isForex, so DXY keeps these features.
  const showAiForexFeatures = !isNse;

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

      {/* Bias Overrides — standalone section, always visible when card is
          open (forex/crypto/commodity + DXY; NSE uses its own bias TF set
          via BiasOverridePanel's asset prop). */}
      {showAiForexFeatures && (
        <div className="check-row">
          <label>Bias Overrides</label>
          <button className="override-btn" onClick={() => setShowBiasOverride(v => !v)}>
            {showBiasOverride ? 'Hide' : 'Edit'} Bias
          </button>
        </div>
      )}
      {showAiForexFeatures && showBiasOverride && (
        <BiasOverridePanel asset={asset} overrides={biasOverrides} onChange={handleOverrideChange} />
      )}

      {showAiForexFeatures && (ebpEnabled || sweepEnabled) && fvgZoneData.length > 0 && (
        <FVGZoneIndicator fvgZones={fvgZoneData} />
      )}

      {/* EBP Alerts */}
      <div className="check-row">
        <input type="checkbox" id={`ebp-${asset.id}`}
          checked={ebpEnabled} onChange={async e => {
            const checked = e.target.checked;
            setEbpEnabled(checked);
            const token = await getToken();
            Promise.all(ebpConfigs.map(cfg =>
              api.patch(`/user/ebp-configs/${cfg.id}`, { enabled: checked ? 1 : 0 }, token)
            )).then(() => { setToast('Changes saved'); setTimeout(() => setToast(null), 2500); });
          }} />
        <label htmlFor={`ebp-${asset.id}`}>EBP Alerts</label>
      </div>
      {ebpEnabled && (
        <EBPConfigPanel
          assetId={asset.id}
          assetType={asset.asset_type}
          allowedTfs={allowedTfs}
          biasCache={biasCache}
          biasOverrides={biasOverrides}
          onUpdate={fetchSummary}
        />
      )}

      {/* Sweep Alerts */}
      <div className="check-row">
        <input type="checkbox" id={`sweep-${asset.id}`}
          checked={sweepEnabled} onChange={async e => {
            const checked = e.target.checked;
            setSweepEnabled(checked);
            const token = await getToken();
            Promise.all(sweepConfigs.map(cfg =>
              api.patch(`/user/sweep-configs/${cfg.id}`, { enabled: checked ? 1 : 0 }, token)
            )).then(() => { setToast('Changes saved'); setTimeout(() => setToast(null), 2500); });
          }} />
        <label htmlFor={`sweep-${asset.id}`}>Sweep Alerts</label>
      </div>
      {sweepEnabled && (
        <SweepConfigPanel
          assetId={asset.id}
          assetType={asset.asset_type}
          allowedTfs={allowedTfs}
          biasCache={biasCache}
          biasOverrides={biasOverrides}
          onUpdate={fetchSummary}
        />
      )}

      {/* AI Alerts — forex/crypto/commodity + DXY; templates/chains aren't
          fetched for NSE at all (see fetchSummary above). */}
      {showAiForexFeatures && (
        <>
          <div className="check-row">
            <input type="checkbox" id={`ai-${asset.id}`}
              checked={aiEnabled} onChange={e => setAiEnabled(e.target.checked)} />
            <label htmlFor={`ai-${asset.id}`}>AI Alert Templates</label>
          </div>
          {aiEnabled && (
            <AIAlertsPanel
              assetId={asset.id}
              chainStates={chainStates}
              onUpdate={fetchSummary}
            />
          )}
        </>
      )}

      {isNse && (
        <>
          {/* TDI Alerts */}
          <div className="check-row">
            <input type="checkbox" id={`tdi-${asset.id}`}
              checked={tdiEnabled} onChange={e => setTdiEnabled(e.target.checked)} />
            <label htmlFor={`tdi-${asset.id}`}>TDI Alerts</label>
          </div>
          {tdiEnabled && <TdiConfigPanel assetId={asset.id} allowedTfs={allowedTfs} onUpdate={fetchSummary} />}

          {/* SMA Cloud Alerts */}
          <div className="check-row">
            <input type="checkbox" id={`sma-nse-${asset.id}`}
              checked={smaEnabled} onChange={e => setSmaEnabled(e.target.checked)} />
            <label htmlFor={`sma-nse-${asset.id}`}>SMA Cloud</label>
          </div>
          {smaEnabled && <SmaConfigPanel assetId={asset.id} allowedTfs={allowedTfs} onUpdate={fetchSummary} />}
        </>
      )}

      {isForex && (
        <>
          {/* SMA Cloud Alerts */}
          <div className="check-row">
            <input type="checkbox" id={`sma-forex-${asset.id}`}
              checked={smaEnabled} onChange={e => setSmaEnabled(e.target.checked)} />
            <label htmlFor={`sma-forex-${asset.id}`}>SMA Cloud</label>
          </div>
          {smaEnabled && <ForexSmaConfigPanel assetId={asset.id} allowedTfs={allowedTfs} onUpdate={fetchSummary} />}
        </>
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--nav-bg)', color: '#f1f5f9', padding: '10px 20px',
          borderRadius: 'var(--radius-md)', fontSize: 13, fontFamily: 'var(--font-mono)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)', zIndex: 2000,
        }}>
          ✓ {toast}
        </div>
      )}
    </div>
  );
}
