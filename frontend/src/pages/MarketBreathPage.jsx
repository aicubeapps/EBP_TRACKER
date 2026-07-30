import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Cell, LabelList,
} from 'recharts';
import api from '../lib/api';

const CURRENCIES = ['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

const CCY_COLORS = {
  EUR: '#3b82f6', GBP: '#8b5cf6', USD: '#10b981', JPY: '#f59e0b',
  CHF: '#ef4444', CAD: '#f97316', AUD: '#ec4899', NZD: '#06b6d4',
};

const BLOCK_COLORS = [
  '#6366f1', // 17–21 indigo
  '#8b5cf6', // 21–01 violet
  '#06b6d4', // 01–05 cyan
  '#10b981', // 05–09 emerald
  '#f59e0b', // 09–13 amber
  '#ef4444', // 13–17 red
];

const BLOCKS = [
  { label: '17–21', startHour: 17, endHour: 21 },
  { label: '21–01', startHour: 21, endHour: 25 },
  { label: '01–05', startHour: 1,  endHour: 5  },
  { label: '05–09', startHour: 5,  endHour: 9  },
  { label: '09–13', startHour: 9,  endHour: 13 },
  { label: '13–17', startHour: 13, endHour: 17 },
];

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

function getNYOffset(epochMs) {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const marchDate = new Date(Date.UTC(year, 2, 1));
  const marchDay = marchDate.getUTCDay();
  const dstStart = new Date(Date.UTC(year, 2, marchDay === 0 ? 8 : 15 - marchDay));
  const novDate = new Date(Date.UTC(year, 10, 1));
  const novDay = novDate.getUTCDay();
  const dstEnd = new Date(Date.UTC(year, 10, novDay === 0 ? 1 : 8 - novDay));
  return (date >= dstStart && date < dstEnd) ? -4 : -5;
}

function toNYMs(epochMs) {
  return epochMs + getNYOffset(epochMs) * 3600000;
}

function getCurrentSessionStart() {
  const nowNY = toNYMs(Date.now());
  const nyDate = new Date(nowNY);
  let sessionStart = new Date(Date.UTC(
    nyDate.getUTCFullYear(),
    nyDate.getUTCMonth(),
    nyDate.getUTCDate(),
    17, 0, 0, 0
  ));
  if (nyDate.getUTCHours() < 17) {
    sessionStart = new Date(sessionStart.getTime() - 24 * 3600000);
  }
  const offset = getNYOffset(sessionStart.getTime());
  return sessionStart.getTime() - offset * 3600000;
}

function getBlockIndex(epochMs) {
  const nyHour = new Date(toNYMs(epochMs)).getUTCHours();
  if (nyHour >= 17) return 0; // 17–21
  if (nyHour >= 13) return 5; // 13–17
  if (nyHour >= 9)  return 4; // 09–13
  if (nyHour >= 5)  return 3; // 05–09
  if (nyHour >= 1)  return 2; // 01–05
  return 1;                   // 21–01
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

  // ── Session boundary ─────────────────────────────────────────────
  const sessionStart = getCurrentSessionStart();

  const sessionSnapshots = (intraday ?? [])
    .filter(s => s.t >= sessionStart)
    .sort((a, b) => a.t - b.t);

  // ── Chart 1: last snapshot per 4H block → stacked horizontal bar ─
  const blockSnapshots = BLOCKS.map((_, i) => {
    const inBlock = sessionSnapshots.filter(s => getBlockIndex(s.t) === i);
    return inBlock.length > 0 ? inBlock[inBlock.length - 1] : null;
  });

  const intradayChartData = (() => {
    const rows = CURRENCIES.map(c => {
      let total = 0;
      const row = { currency: c };
      blockSnapshots.forEach((snap, i) => {
        const val = snap ? (snap.strength[c] ?? 0) : 0;
        row[`block${i}`] = val;
        total += val;
      });
      row._total = total;
      return row;
    });
    // strongest at top (recharts renders data[0] at top for layout="vertical")
    return rows.sort((a, b) => b._total - a._total);
  })();

  // ── Chart 2: today's latest vs yesterday's last snapshot ─────────
  const todayStrength = intraday && intraday.length > 0
    ? intraday[intraday.length - 1].strength
    : null;

  const yesterdaySnapshot = (intraday ?? [])
    .filter(s => s.t < sessionStart)
    .sort((a, b) => b.t - a.t)[0] ?? null;

  const yesterdayStrength = yesterdaySnapshot ? yesterdaySnapshot.strength : null;

  const dailyChartData = todayStrength
    ? [...CURRENCIES]
        .sort((a, b) => (todayStrength[b] ?? 0) - (todayStrength[a] ?? 0))
        .map(c => ({
          currency: c,
          today: todayStrength[c] ?? 0,
          yesterday: yesterdayStrength ? (yesterdayStrength[c] ?? 0) : null,
          delta: yesterdayStrength != null
            ? parseFloat(((todayStrength[c] ?? 0) - (yesterdayStrength[c] ?? 0)).toFixed(4))
            : null,
        }))
    : [];

  // ── Line chart (existing 48h history) ────────────────────────────
  const lineChartData = (intraday ?? []).map(row => ({
    time: fmtTime(row.t),
    ...row.strength,
  }));

  const cardStyle = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '1.5rem',
    marginBottom: '1.5rem',
  };

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

      {/* ── Chart 1: Intraday Strength ────────────────────────────── */}
      <section style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--ink)', marginBottom: '0.25rem' }}>
          Intraday Strength
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '1rem' }}>
          Cumulative from NY 5:00 PM · resets daily · updated hourly
        </div>
        {sessionSnapshots.length < 1 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13, padding: '16px 0', margin: 0 }}>
            Intraday data building… check back after the next hourly update
          </p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart layout="vertical" data={intradayChartData}
                        margin={{ top: 4, right: 60, bottom: 4, left: 0 }}>
                <XAxis type="number"
                       tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--muted)' }}
                       tickFormatter={v => v.toFixed(3)} />
                <YAxis type="category" dataKey="currency" width={40}
                       tick={{ fontSize: 11, fontFamily: 'var(--font-mono)', fill: 'var(--ink)' }} />
                <ReferenceLine x={0} stroke="var(--border)" strokeWidth={2} />
                <Tooltip
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 11 }}
                  formatter={(val, name) => [val?.toFixed(4) ?? '—', name]}
                />
                {BLOCKS.map((block, i) => (
                  <Bar key={i} dataKey={`block${i}`} name={block.label}
                       stackId="strength" fill={BLOCK_COLORS[i]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.25rem', marginTop: '0.75rem' }}>
              {BLOCKS.map((block, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: BLOCK_COLORS[i], flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{block.label} NY</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ── Chart 2: Daily Strength ───────────────────────────────── */}
      <section style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--ink)', marginBottom: '0.25rem' }}>
          Daily Strength
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '1rem' }}>
          Today vs Yesterday · NY session
        </div>
        {dailyChartData.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13, padding: '16px 0', margin: 0 }}>
            No strength data yet.
          </p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart layout="vertical" data={dailyChartData}
                        margin={{ top: 4, right: 60, bottom: 4, left: 0 }}>
                <XAxis type="number"
                       tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--muted)' }}
                       tickFormatter={v => v.toFixed(3)} />
                <YAxis type="category" dataKey="currency" width={40}
                       tick={{ fontSize: 11, fontFamily: 'var(--font-mono)', fill: 'var(--ink)' }} />
                <ReferenceLine x={0} stroke="var(--border)" strokeWidth={2} />
                <Tooltip
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 11 }}
                  formatter={val => val?.toFixed(4) ?? '—'}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="today" name="Today">
                  {dailyChartData.map((entry, i) => (
                    <Cell key={i} fill={entry.today >= 0 ? 'var(--bull)' : 'var(--bear)'} />
                  ))}
                  <LabelList
                    dataKey="delta"
                    position="right"
                    formatter={v => v != null ? `Δ ${v >= 0 ? '+' : ''}${v.toFixed(2)}` : ''}
                    style={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: '#6b6050' }}
                  />
                </Bar>
                <Bar dataKey="yesterday" name="Yesterday">
                  {dailyChartData.map((entry, i) => (
                    <Cell key={i}
                          fill={entry.yesterday != null && entry.yesterday >= 0 ? 'var(--bull)' : 'var(--bear)'}
                          fillOpacity={0.4} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {!yesterdayStrength && (
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: '0.5rem', marginBottom: 0 }}>
                Yesterday baseline available after first full NY session
              </p>
            )}
          </>
        )}
      </section>

      {/* ── Chart 3: Weekly Strength placeholder ─────────────────── */}
      <section style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--ink)', marginBottom: '0.25rem' }}>
          Weekly Strength
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '1rem' }}>
          Previous week · Mon–Fri close
        </div>
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          color: 'var(--muted)',
          border: '1px dashed var(--border)',
          borderRadius: '8px',
          fontSize: '0.875rem',
        }}>
          📅 Weekly data available after Friday NY 5:00 PM close
        </div>
      </section>

      {/* ── Heatmap and Correlation side by side ─────────────────── */}
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

      {/* ── Strength History line chart (48h) ────────────────────── */}
      <section className="card">
        <div className="card-header">
          <span className="card-title">Strength History (48h)</span>
          <span className="text-mono text-muted" style={{ fontSize: 11 }}>hourly snapshots</span>
        </div>
        {lineChartData.length < 2 ? (
          <p className="text-muted" style={{ padding: '16px 0', fontSize: 13 }}>
            Collecting data — chart appears after ≥2 hourly runs.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={lineChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
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
