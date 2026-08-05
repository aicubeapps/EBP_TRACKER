import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell, LabelList,
} from 'recharts';
import api from '../lib/api';

const CURRENCIES = ['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

const CCY_COLORS = {
  EUR: '#3b82f6', GBP: '#8b5cf6', USD: '#10b981', JPY: '#f59e0b',
  CHF: '#ef4444', CAD: '#f97316', AUD: '#ec4899', NZD: '#06b6d4',
};

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York', hour12: false,
  }) + ' NY';
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

// Strength value labels — hug the zero axis, on the side opposite the
// bar's own direction (positive bar extends right → label sits just left
// of zero; negative bar extends left → label sits just right of zero).
// Verified against Recharts 3.8.1 source (Bar.js horizontal-bar branch +
// getBaseValueOfBar): x is ALWAYS the zero-axis pixel (baseValue's scale
// position) regardless of bar sign — width is signed and irrelevant here;
// only needed if referencing the tip, which this design doesn't.
const makeStrengthLabel = (opacity = 1, fontWeight = 600) =>
  ({ x, y, height, value }) => {
    if (value == null || value === 0) return null;
    const isPositive = value >= 0;
    const labelX  = isPositive ? x - GAP : x + GAP;
    const anchor  = isPositive ? 'end' : 'start';
    return (
      <text
        x={labelX}
        y={y + height / 2}
        dy="0.35em"
        textAnchor={anchor}
        fontSize={11}
        fontWeight={fontWeight}
        opacity={opacity}
        fill="currentColor"
      >
        {value >= 0 ? '+' : ''}{value.toFixed(3)}
      </text>
    );
  };

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

  const { intraday, computed_at } = data;

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
                <Bar dataKey="value" name="Strength" radius={[0, 3, 3, 0]}>
                  {intradayChartData.map((entry) => (
                    <Cell
                      key={entry.currency}
                      fill={CCY_COLORS[entry.currency] || '#888'}
                    />
                  ))}
                  <LabelList dataKey="value" content={makeStrengthLabel(1, 600)} />
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
                  <LabelList dataKey="today" content={makeStrengthLabel(1, 600)} />
                </Bar>
                <Bar dataKey="yesterday" name="Yesterday" barSize={10} opacity={0.35}>
                  {dailyChartData.map((entry) => (
                    <Cell
                      key={`yest-${entry.currency}`}
                      fill={CCY_COLORS[entry.currency] || '#888'}
                    />
                  ))}
                  <LabelList dataKey="yesterday" content={makeStrengthLabel(0.5, 400)} />
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

    </div>
  );
}
