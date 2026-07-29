import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import api from '../lib/api';

const CURRENCIES = ['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

const CCY_COLORS = {
  EUR: '#3b82f6', GBP: '#8b5cf6', USD: '#10b981', JPY: '#f59e0b',
  CHF: '#ef4444', CAD: '#f97316', AUD: '#ec4899', NZD: '#06b6d4',
};

function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(3) + '%';
}

function fmtScore(v) {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(4);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false,
  }) + ' UTC';
}

// ── Heatmap cell background ──────────────────────────────────────

function cellStyle(pct) {
  if (pct == null) return {};
  const abs = Math.min(Math.abs(pct), 0.5);
  const alpha = (abs / 0.5) * 0.55 + 0.05;
  return pct >= 0
    ? { background: `rgba(16,185,129,${alpha})`, color: pct > 0.1 ? '#065f46' : 'inherit' }
    : { background: `rgba(239,68,68,${alpha})`,  color: pct < -0.1 ? '#7f1d1d' : 'inherit' };
}

// ── Correlation cell background ──────────────────────────────────

function corrStyle(r, isDiag) {
  if (isDiag) return { background: 'var(--surface)', fontWeight: 700 };
  const abs = Math.abs(r);
  const alpha = abs * 0.5;
  return r > 0
    ? { background: `rgba(16,185,129,${alpha})` }
    : { background: `rgba(239,68,68,${alpha})` };
}

// ── Strength bar ─────────────────────────────────────────────────

function StrengthBar({ value, max }) {
  const pct = max > 0 ? (Math.abs(value) / max) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 120 }}>
      <div style={{
        width: `${pct}%`, minWidth: 3, maxWidth: 80, height: 6, borderRadius: 3,
        background: value >= 0 ? 'var(--bull)' : 'var(--bear)',
        transition: 'width .3s',
      }} />
      <span style={{ color: value >= 0 ? 'var(--bull)' : 'var(--bear)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {fmtScore(value)}
      </span>
    </div>
  );
}

export default function MarketBreathPage() {
  const { getToken } = useAuth();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const d = await api.get('/market/breadth', token);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message ?? 'Failed to load breadth data');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, [load]);

  if (loading) return <div className="shell"><p className="text-muted">Loading market breadth…</p></div>;
  if (error)   return <div className="shell"><p style={{ color: 'var(--bear)' }}>{error}</p></div>;
  if (!data)   return null;

  const { strength, heatmap, intraday, correlation, computed_at } = data;

  // Sort currencies by strength descending
  const ranked = [...CURRENCIES].sort((a, b) => (strength[b] ?? 0) - (strength[a] ?? 0));
  const maxAbs  = Math.max(...CURRENCIES.map(c => Math.abs(strength[c] ?? 0)), 0.0001);

  // Prepare intraday chart data
  const chartData = (intraday ?? []).map(row => {
    const s = typeof row.strength === 'string' ? JSON.parse(row.strength) : row.strength;
    return { time: fmtTime(row.t), ...s };
  });

  return (
    <div className="shell-wide">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 }}>
        <h2 className="section-heading" style={{ margin: 0 }}>Market Breadth</h2>
        {computed_at && (
          <span className="text-mono text-muted" style={{ fontSize: 11 }}>
            Updated {fmtTime(computed_at)}
          </span>
        )}
        <button
          className="btn-ghost"
          style={{ marginLeft: 'auto', fontSize: 12 }}
          onClick={load}
        >
          Refresh
        </button>
      </div>

      {/* ── Strength ranking ──────────────────────────────────── */}
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <span className="card-title">Currency Strength</span>
          <span className="text-mono text-muted" style={{ fontSize: 11 }}>avg % change vs 7 counterparts</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="alert-table" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Currency</th>
                <th>Score</th>
                <th style={{ minWidth: 160 }}>Relative Strength</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((ccy, i) => {
                const score = strength[ccy] ?? 0;
                return (
                  <tr key={ccy}>
                    <td className="text-mono" style={{ color: 'var(--muted)' }}>{i + 1}</td>
                    <td>
                      <span style={{
                        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                        background: CCY_COLORS[ccy], marginRight: 8, verticalAlign: 'middle',
                      }} />
                      <strong style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{ccy}</strong>
                    </td>
                    <td className="text-mono" style={{ color: score >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                      {fmtScore(score)}
                    </td>
                    <td>
                      <StrengthBar value={score} max={maxAbs} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Heatmap and Correlation side by side ─────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* Heatmap */}
        <section className="card">
          <div className="card-header">
            <span className="card-title">Cross-Pair Heatmap</span>
            <span className="text-mono text-muted" style={{ fontSize: 11 }}>% change (row vs col)</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="breadth-heatmap">
              <thead>
                <tr>
                  <th></th>
                  {CURRENCIES.map(c => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {CURRENCIES.map(base => (
                  <tr key={base}>
                    <th>{base}</th>
                    {CURRENCIES.map(quote => {
                      if (base === quote) {
                        return <td key={quote} style={{ background: 'var(--surface)', color: 'var(--muted)' }}>—</td>;
                      }
                      const pct = heatmap?.[base]?.[quote];
                      return (
                        <td key={quote} style={cellStyle(pct)} className="text-mono">
                          {pct != null ? fmtPct(pct) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Correlation matrix */}
        <section className="card">
          <div className="card-header">
            <span className="card-title">Strength Correlation</span>
            <span className="text-mono text-muted" style={{ fontSize: 11 }}>Pearson r, 10-candle series</span>
          </div>
          {!correlation ? (
            <p className="text-muted" style={{ padding: '16px 0', fontSize: 13 }}>
              No correlation data yet — needs ≥2 hourly runs.
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="breadth-heatmap">
                <thead>
                  <tr>
                    <th></th>
                    {CURRENCIES.map(c => <th key={c}>{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {CURRENCIES.map(a => (
                    <tr key={a}>
                      <th>{a}</th>
                      {CURRENCIES.map(b => {
                        const r = correlation?.[a]?.[b];
                        const diag = a === b;
                        return (
                          <td key={b} style={corrStyle(r ?? 0, diag)} className="text-mono"
                            title={`${a}/${b}: ${r?.toFixed(3) ?? '—'}`}
                          >
                            {diag ? '1.0' : (r != null ? r.toFixed(2) : '—')}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* ── Intraday line chart ───────────────────────────────── */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Strength History (48h)</span>
          <span className="text-mono text-muted" style={{ fontSize: 11 }}>hourly snapshots</span>
        </div>
        {chartData.length < 2 ? (
          <p className="text-muted" style={{ padding: '16px 0', fontSize: 13 }}>
            Collecting data — chart appears after ≥2 hourly runs.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--muted)' }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--muted)' }}
                tickFormatter={v => v.toFixed(3)}
              />
              <Tooltip
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 11 }}
                formatter={(v, name) => [fmtScore(v), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {CURRENCIES.map(ccy => (
                <Line
                  key={ccy}
                  type="monotone"
                  dataKey={ccy}
                  stroke={CCY_COLORS[ccy]}
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>
    </div>
  );
}
