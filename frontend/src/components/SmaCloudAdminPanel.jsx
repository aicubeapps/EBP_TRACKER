import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import api from '../lib/api';

const FIELDS = [
  { key: 'fast_period',          label: 'Fast SMA Period',      integer: true },
  { key: 'slow_period',          label: 'Slow SMA Period',      integer: true },
  { key: 'separation_threshold', label: 'Separation Threshold', integer: false },
  { key: 'velocity_threshold',   label: 'Velocity Threshold',   integer: false },
  { key: 'wick_penetration',     label: 'Wick Penetration',     integer: false },
];

// sma_cloud_config's seed row was written by SQLite's datetime('now'), which
// produces 'YYYY-MM-DD HH:MM:SS' — no timezone designator, not guaranteed
// parseable as UTC across browsers. Any admin-edited row instead carries a
// proper new Date().toISOString() value (already ends in a timezone
// designator) — this only matters for a config that's never been saved once.
function normalizeUpdatedAt(str) {
  if (!str) return null;
  const isoish = str.includes('T') ? str : str.replace(' ', 'T');
  return /[Zz]$|[+-]\d{2}:?\d{2}$/.test(isoish) ? isoish : `${isoish}Z`;
}

function formatUpdatedAt(str) {
  const d = new Date(normalizeUpdatedAt(str));
  if (isNaN(d.getTime())) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const mmm  = months[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  const hh   = String(d.getUTCHours()).padStart(2, '0');
  const min  = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd} ${mmm} ${yyyy} ${hh}:${min} UTC`;
}

export default function SmaCloudAdminPanel() {
  const { getToken } = useAuth();
  const [config, setConfig]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState(null);

  const fetchConfig = useCallback(async () => {
    const token = await getToken();
    const data  = await api.get('/admin/sma-config', token);
    setConfig(data);
    setLoading(false);
  }, [getToken]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const token = await getToken();
      await api.patch('/admin/sma-config', {
        fast_period:          parseInt(config.fast_period, 10),
        slow_period:          parseInt(config.slow_period, 10),
        separation_threshold: parseFloat(config.separation_threshold),
        velocity_threshold:   parseFloat(config.velocity_threshold),
        wick_penetration:     parseFloat(config.wick_penetration),
      }, token);
      await fetchConfig();
    } catch (e) {
      setError(e.message || 'Failed to save SMA Cloud config.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="card"><span className="spinner" /></div>;
  }

  const updatedDisplay = formatUpdatedAt(config?.updated_at);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">SMA Cloud Configuration</span>
      </div>
      <p className="text-muted" style={{ fontSize: 13, marginBottom: 16 }}>
        Global parameters for the Forex SMA Cloud phase engine.
        Changes take effect on the next compute-worker cron tick.
      </p>

      {FIELDS.map(({ key, label, integer }) => (
        <div className="config-row" key={key}>
          <span className="text-muted" style={{ width: 180, fontSize: 13 }}>{label}</span>
          <input
            className="select-sm"
            type="number"
            step={integer ? 1 : 0.01}
            min={integer ? 1 : 0.01}
            max={integer ? undefined : 1}
            value={config?.[key] ?? ''}
            onChange={e => setConfig(p => ({ ...p, [key]: e.target.value }))}
          />
        </div>
      ))}

      <div className="config-row" style={{ marginTop: 'var(--sp-sm)' }}>
        <button className="add-link" onClick={handleSave} disabled={saving}>
          {saving ? '…' : 'Save'}
        </button>
      </div>

      {error && (
        <p style={{ color: '#ef4444', fontSize: 11, marginTop: 4 }}>{error}</p>
      )}

      {updatedDisplay && (
        <p className="text-muted" style={{ fontSize: 11, marginTop: 'var(--sp-sm)' }}>
          Last updated: {updatedDisplay}
        </p>
      )}
    </div>
  );
}
