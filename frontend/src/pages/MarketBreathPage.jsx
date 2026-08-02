import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import api from '../lib/api';

const CURRENCIES = ['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

const CCY_COLORS = {
  EUR: '#3b82f6', GBP: '#8b5cf6', USD: '#10b981', JPY: '#f59e0b',
  CHF: '#ef4444', CAD: '#f97316', AUD: '#ec4899', NZD: '#06b6d4',
};

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

// ── Correlation cell background ──────────────────────────────────

function corrStyle(r, isDiag) {
  if (isDiag) return { background: 'var(--surface)', fontWeight: 700 };
  const abs = Math.abs(r);
  const alpha = abs * 0.5;
  return r > 0
    ? { background: `rgba(16,185,129,${alpha})` }
    : { background: `rgba(239,68,68,${alpha})` };
}

// ── Bar labels — positioned near the zero line, opposite side from the
// bar's own direction (positive bars extend right so their label sits to
// the left of zero; negative bars mirror that) ──────────────────────────
const GAP = 6; // px from the zero line

function DeltaLabel(props) {
  const { x, y, width, height, value, payload } = props;
  if (value === undefined || value === null) return null;

  // Position/direction come from the Today bar's own geometry (value here
  // is "today", per the Bar's dataKey) — that's what "opposite side from
  // the bar" means. The displayed number is the delta, a different field
  // on the same row, which recharts passes through as `payload` rather
  // than `value` when using a Bar's `label` prop (unlike LabelList, which
  // takes an explicit dataKey to pull a different field than the bar).
  const delta = payload?.delta;
  if (delta === undefined || delta === null) return null;

  const isPositive = value >= 0;
  const zeroX = isPositive ? x : x + width;
  const labelX = isPositive ? zeroX - GAP : zeroX + GAP;
  const labelAnchor = isPositive ? 'end' : 'start';

  return (
    <text
      x={labelX}
      y={y + height / 2}
      textAnchor={labelAnchor}
      dominantBaseline="middle"
      fontSize={10}
      fill={delta >= 0 ? 'var(--bull)' : 'var(--bear)'}
    >
      {delta >= 0 ? `Δ +${delta.toFixed(4)}` : `Δ ${delta.toFixed(4)}`}
    </text>
  );
}

function IntradayLabel(props) {
  const { x, y, width, height, value } = props;
  if (!value) return null;

  const isPositive = value >= 0;
  const zeroX = isPositive ? x : x + width;
  const labelX = isPositive ? zeroX - GAP : zeroX + GAP;
  const labelAnchor = isPositive ? 'end' : 'start';

  return (
    <text
      x={labelX}
      y={y + height / 2}
      textAnchor={labelAnchor}
      dominantBaseline="middle"
      fontSize={10}
      fill={value >= 0 ? 'var(--bull)' : 'var(--bear)'}
    >
      {value.toFixed(3)}
    </text>
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

  const { intraday, correlation, computed_at } = data;

  // ── Session boundary ─────────────────────────────────────────────
  const sessionStart = getCurrentSessionStart();

  const sessionSnapshots = (intraday ?? [])
    .filter(s => s.t >= sessionStart)
    .sort((a, b) => a.t - b.t);

  // ── Chart 1: latest session snapshot → single CCY_COLORS bar ────
  const latestSessionSnap = sessionSnapshots[sessionSnapshots.length - 1] ?? null;

  const intradayChartData = latestSessionSnap
    ? Object.entries(latestSessionSnap.strength)
        .sort((a, b) => b[1] - a[1])
        .map(([currency, value]) => ({
          currency,
          value: parseFloat(value.toFixed(4)),
        }))
    : [];

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

  // ── Line chart (48h history) ──────────────────────────────────────
  const OUTLIER_THRESHOLD = 0.3;
  const filteredIntraday = (intraday ?? []).filter(snap => {
    const vals = Object.values(snap.strength);
    return vals.every(v => Math.abs(v) <= OUTLIER_THRESHOLD);
  });

  const lineChartData = filteredIntraday.map(row => ({
    t: row.t,
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
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                layout="vertical"
                data={intradayChartData}
                margin={{ top: 8, right: 48, left: 8, bottom: 8 }}
              >
                <XAxis type="number"
                       tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--muted)' }}
                       tickFormatter={v => v.toFixed(3)} />
                <YAxis type="category" dataKey="currency" width={40}
                       tick={{ fontSize: 11, fontFamily: 'var(--font-mono)', fill: 'var(--ink)' }} />
                <ReferenceLine x={0} stroke="var(--border)" strokeWidth={2} />
                <Tooltip
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 11 }}
                  formatter={val => val.toFixed(4)}
                />
                <Bar dataKey="value" name="Strength" radius={[0, 3, 3, 0]} label={<IntradayLabel />}>
                  {intradayChartData.map((entry) => (
                    <Cell
                      key={entry.currency}
                      fill={CCY_COLORS[entry.currency] || '#888'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              marginTop: '0.75rem',
              justifyContent: 'center',
            }}>
              {intradayChartData.map(({ currency }) => (
                <span key={currency} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  fontSize: '0.75rem',
                  color: 'var(--ink)',
                }}>
                  <span style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    backgroundColor: CCY_COLORS[currency] || '#888',
                    display: 'inline-block',
                  }} />
                  {currency}
                </span>
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
                <Bar dataKey="today" name="Today" barSize={10} label={<DeltaLabel />}>
                  {dailyChartData.map((entry) => (
                    <Cell
                      key={`today-${entry.currency}`}
                      fill={CCY_COLORS[entry.currency] || '#888'}
                    />
                  ))}
                </Bar>
                <Bar dataKey="yesterday" name="Yesterday" barSize={10} opacity={0.35}>
                  {dailyChartData.map((entry) => (
                    <Cell
                      key={`yest-${entry.currency}`}
                      fill={CCY_COLORS[entry.currency] || '#888'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {!yesterdayStrength && (
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: '0.5rem', marginBottom: 0 }}>
                Yesterday baseline available after first full NY session
              </p>
            )}
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.75rem',
                justifyContent: 'center',
                marginBottom: '0.4rem',
              }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--muted)', marginRight: '0.25rem' }}>Today:</span>
                {dailyChartData.map(({ currency }) => (
                  <span key={currency} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    fontSize: '0.75rem',
                    color: 'var(--ink)',
                  }}>
                    <span style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      backgroundColor: CCY_COLORS[currency] || '#888',
                      display: 'inline-block',
                    }} />
                    {currency}
                  </span>
                ))}
              </div>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.75rem',
                justifyContent: 'center',
              }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--muted)', marginRight: '0.25rem' }}>Yesterday:</span>
                {dailyChartData.map(({ currency }) => (
                  <span key={currency} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    fontSize: '0.75rem',
                    color: 'var(--ink)',
                  }}>
                    <span style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      backgroundColor: CCY_COLORS[currency] || '#888',
                      opacity: 0.35,
                      display: 'inline-block',
                    }} />
                    {currency}
                  </span>
                ))}
              </div>
            </div>
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

      {/* ── Correlation matrix (heatmap removed) ─────────────────── */}
      <div className="breadth-grid">
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
            <div style={{ position: 'relative', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table className="breadth-heatmap" style={{ minWidth: 480 }}>
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
              <div style={{
                position: 'absolute',
                right: 0,
                top: 0,
                bottom: 0,
                width: 24,
                background: 'linear-gradient(to right, transparent, rgba(243,237,227,0.8))',
                pointerEvents: 'none',
                borderRadius: '0 8px 8px 0',
              }} />
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
            <LineChart data={lineChartData} margin={{ top: 8, right: 16, bottom: 8, left: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(ms) => {
                  const d = new Date(ms);
                  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
                }}
                tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--muted)' }}
                interval="preserveStartEnd"
                minTickGap={60}
              />
              <YAxis
                width={40}
                tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--muted)' }}
                tickFormatter={v => v.toFixed(3)}
              />
              <Tooltip
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 11 }}
                formatter={(v, name) => [fmtScore(v), name]}
                labelFormatter={fmtTime}
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
