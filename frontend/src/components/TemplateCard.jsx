import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { TEMPLATE_HTF_OPTIONS, TEMPLATE_ALL_TFS, templateLtfOptions, FVG_RULE_OPTIONS, TEMPLATE_WINDOW_MINS_MIN, TEMPLATE_WINDOW_MINS_MAX } from '../lib/constants';
import { ChainProgressBar } from './ChainProgressBar';

const FVG_RULE_TEMPLATES = ['t1', 't2', 't4'];

export function TemplateCard({ tmpl, active, chain, assetId, onUpdate, onToast }) {
  const { getToken } = useAuth();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const savedTimer    = useRef(null);
  const toastTimerRef = useRef(null);

  useEffect(() => () => clearTimeout(savedTimer.current), []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const fireReConfigToast = () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      onToast?.('✓ Re-Config Done', 'reconfig');
    }, 2000);
  };

  const isEnabled = !!active?.enabled;

  function flashSaved() {
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }

  async function handleToggle(checked) {
    setSaving(true);
    try {
      const token = await getToken();
      if (checked && !active) {
        const body = {
          template: tmpl.key,
          enabled: 1,
          htf: '4H',
          ltf: 'M15',
          window_mins: 60,
        };
        if (tmpl.key === 't2') {
          body.ote_enabled = 1;
          body.sweep_required = 0;
          body.trigger_type = 'cisd';
          body.mss_tf = body.ltf;
          body.bias_mode = 'ttrades';
          body.manual_bias = '';
        }
        await api.post(`/user/templates/${assetId}`, body, token);
        onUpdate?.();
        onToast?.('✓ Alert Added', 'add');
      } else if (active) {
        await api.patch(`/user/template/${active.id}`, { enabled: checked ? 1 : 0 }, token);
        onUpdate?.();
        if (!checked) onToast?.('✕ Alert Removed', 'remove');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(field, value) {
    if (!active) return;
    const token = await getToken();
    await api.patch(`/user/template/${active.id}`, { [field]: value }, token);
    flashSaved();
    onUpdate?.();
    fireReConfigToast();
  }

  // HTF change can leave the stored LTF invalid (LTF must rank strictly
  // below HTF) — the backend only cross-checks htf/ltf when both are in
  // the same PATCH body, so a lone {htf} patch wouldn't catch it. Reset
  // LTF to the highest valid option below the new HTF and send both
  // together.
  async function handleHtfChange(newHtf) {
    if (!active) return;
    const options = templateLtfOptions(newHtf);
    const newLtf  = options[options.length - 1];
    const token   = await getToken();
    await api.patch(`/user/template/${active.id}`, { htf: newHtf, ltf: newLtf }, token);
    flashSaved();
    onUpdate?.();
    fireReConfigToast();
  }

  return (
    <div className={`template-card ${isEnabled ? 'template-card--active' : ''}`}>
      <div className="template-card__header">
        <div className="template-card__title">
          <span className="template-card__type">{tmpl.key.toUpperCase()}</span>
          <span className="template-card__label">{tmpl.label}</span>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={isEnabled}
            disabled={saving}
            onChange={e => handleToggle(e.target.checked)}
          />
          <span className="toggle__track" />
        </label>
      </div>

      <p className="template-card__desc">{tmpl.description}</p>

      {isEnabled && active && (
        <div className="template-card__config">
          <div className="template-card__row">
            <label>HTF</label>
            <select className="select-sm" value={active.htf} onChange={e => handleHtfChange(e.target.value)}>
              {TEMPLATE_HTF_OPTIONS.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <label>LTF</label>
            <select className="select-sm" value={active.ltf} onChange={e => handleUpdate('ltf', e.target.value)}>
              {templateLtfOptions(active.htf).map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            {saved && <span className="bias-label">Saved ✓</span>}
          </div>

          <div className="template-card__row">
            <label>Bias gate</label>
            <select className="select-sm" value={active.bias_gate ?? 1}
              onChange={e => handleUpdate('bias_gate', parseInt(e.target.value, 10))}>
              <option value={1}>On</option>
              <option value={0}>Off</option>
            </select>
          </div>

          {tmpl.key === 't2' && (
            <>
              <div className="template-card__row">
                <label>OTE Zone</label>
                <select className="select-sm" value={active.ote_enabled ?? 1}
                  onChange={e => handleUpdate('ote_enabled', parseInt(e.target.value, 10))}>
                  <option value={1}>Enabled</option>
                  <option value={0}>Disabled</option>
                </select>
              </div>

              <div className="template-card__row">
                <label>Sweep Required</label>
                <select className="select-sm" value={active.sweep_required ?? 0}
                  onChange={e => handleUpdate('sweep_required', parseInt(e.target.value, 10))}>
                  <option value={1}>Yes</option>
                  <option value={0}>No</option>
                </select>
              </div>

              <div className="template-card__row">
                <label>Trigger Type</label>
                <select className="select-sm" value={active.trigger_type ?? 'cisd'}
                  onChange={e => handleUpdate('trigger_type', e.target.value)}>
                  <option value="cisd">CISD</option>
                  <option value="mss">MSS</option>
                  <option value="either">Either</option>
                </select>
              </div>

              <div className="template-card__row">
                <label>MSS Timeframe</label>
                <select className="select-sm" value={active.mss_tf ?? active.ltf}
                  onChange={e => handleUpdate('mss_tf', e.target.value)}>
                  {TEMPLATE_ALL_TFS.map(tf => <option key={tf} value={tf}>{tf}</option>)}
                </select>
              </div>

              <div className="template-card__row">
                <label>Bias Mode</label>
                <select className="select-sm" value={active.bias_mode ?? 'ttrades'}
                  onChange={e => handleUpdate('bias_mode', e.target.value)}>
                  <option value="ttrades">TTrades</option>
                  <option value="htf_sma">HTF SMA</option>
                  <option value="off">Off</option>
                </select>
              </div>

              {(active.bias_mode ?? 'ttrades') === 'off' && (
                <div className="template-card__row">
                  <label>Manual Bias</label>
                  <select className="select-sm" value={active.manual_bias ?? ''}
                    onChange={e => handleUpdate('manual_bias', e.target.value)}>
                    <option value="">Auto</option>
                    <option value="bullish">Bullish</option>
                    <option value="bearish">Bearish</option>
                  </select>
                </div>
              )}
            </>
          )}

          {FVG_RULE_TEMPLATES.includes(tmpl.key) && (
            <div className="template-card__row">
              <label>FVG rule</label>
              <select className="select-sm" value={active.fvg_rule ?? '50_percent'}
                onChange={e => handleUpdate('fvg_rule', e.target.value)}>
                {FVG_RULE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}

          {tmpl.key === 't3' && (
            <>
              <div className="template-card__row">
                <label>Step 3 (MSS)</label>
                <select className="select-sm" value={active.step3_enabled ?? 1}
                  onChange={e => handleUpdate('step3_enabled', parseInt(e.target.value, 10))}>
                  <option value={1}>Enabled</option>
                  <option value={0}>Disabled (EBP + Sweep only)</option>
                </select>
              </div>
              <div className="template-card__row">
                <label>Window</label>
                <input
                  type="number"
                  className="select-sm"
                  style={{ width: 64 }}
                  min={TEMPLATE_WINDOW_MINS_MIN}
                  max={TEMPLATE_WINDOW_MINS_MAX}
                  value={active.window_mins ?? 60}
                  onChange={e => {
                    const val = parseInt(e.target.value, 10);
                    if (!Number.isNaN(val)) handleUpdate('window_mins', val);
                  }}
                />
                <span className="template-card__unit">min</span>
              </div>
            </>
          )}

          <div className="template-card__chain">
            <span className="template-card__chain-label">Chain</span>
            <ChainProgressBar chain={chain} templateType={tmpl.key.toUpperCase()} />
          </div>
        </div>
      )}
    </div>
  );
}
