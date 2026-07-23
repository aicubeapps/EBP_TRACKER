import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Box, Stack, Checkbox, Typography, Chip, CircularProgress } from '@mui/material';
import api from '../lib/api';

const TEMPLATES = [
  { id: 't1', label: 'T1', description: 'HTF FVG → Price at zone → LTF confirmation', minTier: 'wine' },
  { id: 't2', label: 'T2', description: 'HTF EBP → LTF FVG retracement → LTF MSS',    minTier: 'wine' },
  { id: 't3', label: 'T3', description: 'HTF EBP → LTF Sweep → LTF MSS',              minTier: 'beer' },
  { id: 't4', label: 'T4', description: 'HTF Sweep → HTF FVG pullback → LTF MSS',     minTier: 'wine' },
];

const TIER_ORDER = ['free', 'chai', 'coffee', 'beer', 'wine', 'whiskey'];

function canUseTier(userTier, minTier) {
  return TIER_ORDER.indexOf(userTier) >= TIER_ORDER.indexOf(minTier);
}

export default function AIAlertsPanel({ assetId, tier }) {
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

  if (loading) return <CircularProgress size={16} sx={{ ml: 3, mt: 1 }} />;

  return (
    <Box sx={{ ml: 3, mt: 1 }}>
      {TEMPLATES.map(tmpl => {
        const unlocked = canUseTier(tier, tmpl.minTier);
        const active   = templates.find(t => t.template === tmpl.id);

        return (
          <Stack
            key={tmpl.id}
            direction="row"
            alignItems="center"
            gap={1}
            sx={{ mb: 1, opacity: unlocked ? 1 : 0.4 }}
          >
            <Checkbox
              size="small"
              checked={!!active?.enabled}
              disabled={!unlocked}
              onChange={e => unlocked && toggleTemplate(tmpl.id, e.target.checked)}
            />
            <Typography variant="body2" fontWeight={700}>{tmpl.label}</Typography>
            <Typography variant="body2" color="text.secondary">→ {tmpl.description}</Typography>
            {!unlocked && (
              <Chip
                label={`${tmpl.minTier} required`}
                size="small"
                color="warning"
                variant="outlined"
              />
            )}
          </Stack>
        );
      })}
    </Box>
  );
}
