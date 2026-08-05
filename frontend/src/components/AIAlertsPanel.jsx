import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';
import { TemplateCard } from './TemplateCard';

const TEMPLATES = [
  {
    key: 't1',
    label: 'HTF FVG → LTF confirmation',
    description: 'HTF FVG → Price at zone → LTF confirmation',
  },
  {
    key: 't2',
    label: 'HTF EBP → LTF FVG retracement',
    description: 'HTF EBP → LTF FVG retracement → LTF MSS',
  },
  {
    key: 't3',
    label: 'HTF EBP → LTF Sweep → LTF MSS',
    description: 'HTF EBP → LTF Sweep → LTF MSS',
  },
  {
    key: 't4',
    label: 'HTF Sweep → HTF FVG pullback',
    description: 'HTF Sweep → HTF FVG pullback → LTF MSS',
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
