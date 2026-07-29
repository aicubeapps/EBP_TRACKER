import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { TEMPLATE_HTF_OPTIONS, templateLtfOptions } from '../lib/constants';

const TEMPLATES = [
  { id: 't1', label: 'T1', description: 'HTF FVG → Price at zone → LTF confirmation', comingSoon: true },
  { id: 't2', label: 'T2', description: 'HTF EBP → LTF FVG retracement → LTF MSS',    comingSoon: true },
  { id: 't3', label: 'T3', description: 'HTF EBP → LTF Sweep → LTF MSS',              comingSoon: false },
  { id: 't4', label: 'T4', description: 'HTF Sweep → HTF FVG pullback → LTF MSS',     comingSoon: true },
];

export default function AIAlertsPanel({ assetId }) {
  const { getToken } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [savedId, setSavedId]     = useState(null);
  const savedTimer = useRef(null);

  const fetchTemplates = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get(`/user/templates/${assetId}`, token);
    setTemplates(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [assetId, getToken]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  function flashSaved(templateId) {
    setSavedId(templateId);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedId(null), 1500);
  }

  async function toggleTemplate(templateId, enabled) {
    const token    = await getToken();
    const existing = templates.find(t => t.template === templateId);
    if (existing) {
      await api.patch(`/user/template/${existing.id}`, { enabled: enabled ? 1 : 0 }, token);
      setTemplates(prev => prev.map(t => t.id === existing.id ? { ...t, enabled: enabled ? 1 : 0 } : t));
    } else {
      const res = await api.post(`/user/templates/${assetId}`, {
        template: templateId,
        enabled: 1,
        htf: '4H',
        ltf: 'M15',
        window_mins: 60,
      }, token);
      setTemplates(prev => [...prev, { id: res.id, template: templateId, enabled: 1, htf: '4H', ltf: 'M15', window_mins: 60 }]);
    }
  }

  // HTF change resets LTF to the highest valid option below it (e.g. 1H → M30).
  async function handleHtfChange(templateId, newHtf) {
    const existing = templates.find(t => t.template === templateId);
    if (!existing) return;
    const options = templateLtfOptions(newHtf);
    const newLtf  = options[options.length - 1];
    const token   = await getToken();
    await api.patch(`/user/template/${existing.id}`, { htf: newHtf, ltf: newLtf }, token);
    setTemplates(prev => prev.map(t => t.id === existing.id ? { ...t, htf: newHtf, ltf: newLtf } : t));
    flashSaved(templateId);
  }

  async function handleLtfChange(templateId, newLtf) {
    const existing = templates.find(t => t.template === templateId);
    if (!existing) return;
    const token = await getToken();
    await api.patch(`/user/template/${existing.id}`, { htf: existing.htf, ltf: newLtf }, token);
    setTemplates(prev => prev.map(t => t.id === existing.id ? { ...t, ltf: newLtf } : t));
    flashSaved(templateId);
  }

  if (loading) return <div className="config-panel"><span className="spinner" /></div>;

  return (
    <div className="config-panel">
      {TEMPLATES.map(tmpl => {
        const active = templates.find(t => t.template === tmpl.id);
        const htf    = active?.htf ?? '4H';
        const ltf    = active?.ltf ?? 'M15';

        return (
          <div key={tmpl.id}>
            <div className="ai-template-row">
              <input
                type="checkbox"
                checked={!!active?.enabled}
                onChange={e => toggleTemplate(tmpl.id, e.target.checked)}
              />
              <span className="ai-template-label">{tmpl.label}</span>
              <span className="ai-template-desc">→ {tmpl.description}</span>
              {tmpl.comingSoon && (
                <span className="ai-template-lock">Coming Soon</span>
              )}
            </div>
            {active?.enabled && (
              <div className="config-row" style={{ marginLeft: 28, marginBottom: 8 }}>
                <select className="select-sm" value={htf}
                  onChange={e => handleHtfChange(tmpl.id, e.target.value)}>
                  {TEMPLATE_HTF_OPTIONS.map(tf => <option key={tf} value={tf}>{tf}</option>)}
                </select>
                {htf === 'M15' ? (
                  <span className="bias-label">LTF: M5</span>
                ) : (
                  <select className="select-sm" value={ltf}
                    onChange={e => handleLtfChange(tmpl.id, e.target.value)}>
                    {templateLtfOptions(htf).map(tf => <option key={tf} value={tf}>{tf}</option>)}
                  </select>
                )}
                {savedId === tmpl.id && <span className="bias-label">Saved ✓</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
