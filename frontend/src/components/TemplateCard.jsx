import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { TEMPLATE_HTF_OPTIONS, templateLtfOptions, FVG_RULE_OPTIONS, TEMPLATE_WINDOW_MINS_MIN, TEMPLATE_WINDOW_MINS_MAX } from '../lib/constants';
import { ChainProgressBar } from './ChainProgressBar';

const FVG_RULE_TEMPLATES = ['t1', 't2', 't4'];

export function TemplateCard({ tmpl, active, chain, assetId, onUpdate }) {
  const { getToken } = useAuth();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const savedTimer = useRef(null);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

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
        await api.post(`/user/templates/${assetId}`, {
          template: tmpl.key,
          enabled: 1,
          htf: '4H',
          ltf: 'M15',
          window_mins: 60,
        }, token);
      } else if (active) {
        await api.patch(`/user/template/${active.id}`, { enabled: checked ? 1 : 0 }, token);
      }
      onUpdate?.();
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
