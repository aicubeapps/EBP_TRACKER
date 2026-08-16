import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { TemplateCard } from './TemplateCard';

const TEMPLATES = [
  {
    key: 't1',
    label: 'HTF FVG → LTF confirmation',
    description: "4H EBP arms the chain silently. Alert fires when an M15 FVG forms inside the EBP candle's OTE zone and price body-closes beyond it.",
  },
  {
    key: 't2',
    label: 'HTF EBP → LTF FVG retracement',
    description: '4H EBP arms the chain. Waits for zone entry, optional sweep, then a CISD or MSS trigger. Sends up to 3 stepped alerts (/S1 /S2 /S3).',
  },
  {
    key: 't3',
    label: 'HTF EBP → LTF Sweep → LTF MSS',
    description: "Previous day's NY close candle → unmitigated 4H/1H FVG in the 50–75% zone → NY 23:00 time gate → S2 alert at FVG wick, S3 at CISD or MSS.",
  },
  {
    key: 't4',
    label: 'HTF Sweep → HTF FVG pullback',
    description: 'Daily bias gate → intraday MSS (1H/M30) → pullback into premium/discount FVG → M15 body close beyond FVG. Dual targets, hard kill if prior day level swept. Expires NY 17:00.',
  },
];

export default function AIAlertsPanel({ assetId, chainStates, onUpdate }) {
  const { getToken } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(true);

  const fetchTemplates = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get(`/user/templates/${assetId}`, token);
    setTemplates(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [assetId, getToken]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const refetch = useCallback(async () => {
    await fetchTemplates();
    onUpdate?.();
  }, [fetchTemplates, onUpdate]);

  if (loading) return <div className="config-panel"><span className="spinner" /></div>;

  return (
    <div className="config-panel">
      {TEMPLATES.map(tmpl => {
        const active = templates.find(t => t.template === tmpl.key) ?? null;
        const chain  = chainStates?.find(c => c.template_type === tmpl.key.toUpperCase()) ?? null;

        return (
          <TemplateCard
            key={tmpl.key}
            tmpl={tmpl}
            active={active}
            chain={chain}
            assetId={assetId}
            onUpdate={refetch}
          />
        );
      })}
    </div>
  );
}
