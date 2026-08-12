// ============================================================
// Compute Worker — Market Breadth + Forex/Crypto SMA Cloud
//
// Absorbs two cron paths previously split across other workers:
//   - Market Breadth (was ebp-worker.js's Cloudflare native cron,
//     scheduled() → handleMarketBreadthCron)
//   - Forex/Crypto SMA Cloud (was sweep-worker/src/sweep-cron.js's
//     handleForexSmaCron, driven by cron-job.org via POST /cron/sma)
//
// Routes:
//   GET  /health    — public health check
//   POST /cron/sma  — HTTP cron trigger (secured by X-Cron-Secret)
//
// Market Breadth runs on Cloudflare's native cron trigger (see
// wrangler.toml [triggers], fires hourly at :05); Forex SMA Cloud stays
// on cron-job.org HTTP triggers, same pattern sweep-worker used.
// ============================================================

// ── CORS (mirrors sweep-worker/src/index.js) ────────────────────

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://ebp-tracker.pages.dev',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Cron-Secret',
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// ── Candle Cache reads (inlined — no cross-package imports) ──
// Watchdog Worker is the sole Twelve Data / Yahoo caller and the sole
// writer of candle_cache / daily_candle_cache / weekly_candle_cache.
// Compute Worker only reads, same pattern as every other worker.

// M15/M30/1H/4H — read the JSON blob Watchdog writes per fetch cycle.
// Stale cache (Watchdog missed a cycle, all TD keys + Yahoo failed, etc.)
// is treated as no data rather than risking detection on old bars.
async function getCandlesFromCache(symbol, tf, env) {
  const row = await env.DB.prepare(
    'SELECT candles_json, fetched_at FROM candle_cache WHERE symbol = ? AND tf = ?'
  ).bind(symbol, tf).first();

  if (!row) return null;

  const intervalMs = { M15: 15 * 60 * 1000, M30: 30 * 60 * 1000, '1H': 60 * 60 * 1000, '4H': 4 * 60 * 60 * 1000 };
  const age = Date.now() - new Date(row.fetched_at).getTime();
  // 4H gets a tighter window (1.25x = 5h) than the 2x default — a 4H candle
  // that's 2 intervals (8h) stale is far more likely to be a genuinely
  // missed Watchdog fetch than the equivalent staleness on faster TFs.
  const maxAge = tf === '4H' ? 1.25 * intervalMs['4H'] : 2 * intervalMs[tf];
  if (age > maxAge) {
    console.warn(`Stale cache for ${symbol} ${tf}: ${age}ms old`);
    return null;
  }

  return JSON.parse(row.candles_json);
}

// Dedicated Yahoo-sourced breadth cache — watchdog-worker's
// fetchBreadthFromYahoo() writes MAJOR_PAIRS candles here (not
// candle_cache) as of its 2026-08-12 rebuild; Market Breadth reads them
// from here rather than candle_cache. Same staleness-gating pattern as
// getCandlesFromCache above, just a different source table.
async function getYahooCandlesFromCache(symbol, tf, env) {
  const row = await env.DB.prepare(
    'SELECT candles_json, fetched_at FROM yahoo_candle_cache WHERE symbol = ? AND tf = ?'
  ).bind(symbol, tf).first();

  if (!row) return null;

  const intervalMs = { M15: 15 * 60 * 1000, M30: 30 * 60 * 1000, '1H': 60 * 60 * 1000, '4H': 4 * 60 * 60 * 1000 };
  const age = Date.now() - new Date(row.fetched_at).getTime();
  const maxAge = tf === '4H' ? 1.25 * intervalMs['4H'] : 2 * intervalMs[tf];
  if (age > maxAge) {
    console.warn(`Stale yahoo cache for ${symbol} ${tf}: ${age}ms old`);
    return null;
  }

  return JSON.parse(row.candles_json);
}

// daily_candle_cache stores OHLC + a calendar date string, not a
// candle-open timestamp — reconstruct bar.time from the trading-day
// boundary (17:00 NY the prior calendar day), same approach as every
// other worker's cache readers.
function nyDateAtHourToUTCms(dateStr, hour) {
  const naiveMs = Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset'
  }).formatToParts(new Date(naiveMs));
  const offsetStr   = parts.find(p => p.type === 'timeZoneName').value;
  const offsetHours = parseInt(offsetStr.replace('GMT', ''));
  return naiveMs - offsetHours * 3600 * 1000;
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// 1H sweep configs need 'D' HTF bias, 4H configs need 'W' — both come from
// Watchdog's synthesised tables, not candle_cache. LIMIT 25 (not the
// original 5) — forex SMA Cloud's htf_sma bias mode needs 9 daily closes
// minimum for SMA9; TTrades bias (the only other consumer) only ever reads
// candles[0]/[1] regardless of how many rows come back, so raising this is
// safe for that path too.
async function getDailyCandlesFromCache(symbol, env) {
  const { results } = await env.DB.prepare(
    'SELECT date_ny, open, high, low, close FROM daily_candle_cache WHERE symbol = ? ORDER BY date_ny DESC LIMIT 25'
  ).bind(symbol).all();
  return (results ?? []).map(r => ({
    open: r.open, high: r.high, low: r.low, close: r.close,
    time: nyDateAtHourToUTCms(addDaysToDateStr(r.date_ny, -1), 17),
  }));
}

// ── Telegram (inlined, standalone) ────────

async function sendTelegramMessage(botToken, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data;
}

// P1 — alert dedup guard. One window per fired TF; same symbol+TF+direction+
// alertType within that window is treated as a duplicate and skipped.
const ALERT_INTERVAL_MS = {
  M15: 15 * 60 * 1000,
  M30: 30 * 60 * 1000,
  '1H': 60 * 60 * 1000,
  '4H': 4 * 60 * 60 * 1000,
  D:   24 * 60 * 60 * 1000,
  W:   7  * 24 * 60 * 60 * 1000,
};

// fired_at is stored as an INTEGER ms epoch (Date.now(), never
// toISOString()) — the cutoff bound here must match that type, or SQLite's
// NULL < INTEGER/REAL < TEXT affinity rule makes every comparison against
// an INTEGER column silently false regardless of the TEXT value.
async function isDuplicateAlert(db, userId, symbol, tf, direction, alertType) {
  const windowMs = ALERT_INTERVAL_MS[tf] || 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  const existing = await db.prepare(`
    SELECT id FROM alert_history
    WHERE user_id = ?
    AND symbol = ?
    AND timeframe = ?
    AND direction = ?
    AND alert_type = ?
    AND fired_at > ?
    LIMIT 1
  `).bind(userId, symbol, tf, direction, alertType, cutoff).first();

  return existing !== null;
}

function fmtNY(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit',
    hour12: true, month: 'short', day: 'numeric',
  });
}

// ── Market Breadth ────────────────────────────────────────────────

const BREADTH_CURRENCIES = ['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

// 28 cross-pairs covering all C(8,2) combinations.
// Each entry: [pair, base, quote] using market-convention pair name.
// pct = (close−open)/open*100; positive pct → base appreciated vs quote.
const MAJOR_PAIRS = [
  ['EUR/USD', 'EUR', 'USD'], ['GBP/USD', 'GBP', 'USD'], ['USD/JPY', 'USD', 'JPY'],
  ['USD/CHF', 'USD', 'CHF'], ['USD/CAD', 'USD', 'CAD'], ['AUD/USD', 'AUD', 'USD'],
  ['NZD/USD', 'NZD', 'USD'], ['EUR/GBP', 'EUR', 'GBP'], ['EUR/JPY', 'EUR', 'JPY'],
  ['EUR/CHF', 'EUR', 'CHF'], ['EUR/CAD', 'EUR', 'CAD'], ['EUR/AUD', 'EUR', 'AUD'],
  ['EUR/NZD', 'EUR', 'NZD'], ['GBP/JPY', 'GBP', 'JPY'], ['GBP/CHF', 'GBP', 'CHF'],
  ['GBP/CAD', 'GBP', 'CAD'], ['GBP/AUD', 'GBP', 'AUD'], ['GBP/NZD', 'GBP', 'NZD'],
  ['CHF/JPY', 'CHF', 'JPY'], ['CAD/JPY', 'CAD', 'JPY'], ['AUD/JPY', 'AUD', 'JPY'],
  ['NZD/JPY', 'NZD', 'JPY'], ['AUD/CAD', 'AUD', 'CAD'], ['AUD/CHF', 'AUD', 'CHF'],
  ['AUD/NZD', 'AUD', 'NZD'], ['NZD/CAD', 'NZD', 'CAD'], ['NZD/CHF', 'NZD', 'CHF'],
  ['CAD/CHF', 'CAD', 'CHF'],
];

function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const meanA = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const meanB = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA, dB = b[i] - meanB;
    num += dA * dB; da += dA * dA; db += dB * dB;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

async function handleMarketBreadthCron(env, debugLog = []) {
  // Forex weekend gate — Friday 17:00 NY through Sunday 17:00 NY, no new 1H
  // bars are actually forming, so breadth computation is suppressed. Reuses
  // the same Intl shortOffset technique nyDateAtHourToUTCms already uses
  // for daily/weekly candle synthesis (not a new DST helper), just applied
  // in the other direction — current UTC instant to NY wall-clock.
  const nowUtc = new Date();
  const nyOffsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(nowUtc);
  const nyOffsetStr   = nyOffsetParts.find(p => p.type === 'timeZoneName').value;
  const nyOffsetHours = parseInt(nyOffsetStr.replace('GMT', ''));
  const nyWallClock   = new Date(nowUtc.getTime() + nyOffsetHours * 3600 * 1000);
  const nyDayOfWeek   = nyWallClock.getUTCDay();
  const nyHour        = nyWallClock.getUTCHours();

  const isForexWeekend =
    (nyDayOfWeek === 5 && nyHour >= 17) || // Friday from 17:00
    nyDayOfWeek === 6 ||                   // all Saturday
    (nyDayOfWeek === 0 && nyHour < 17);    // Sunday before 17:00

  if (isForexWeekend) {
    console.log('Market breadth cron skipped — forex weekend (Friday 17:00 to Sunday 17:00 NY)');
    return { skipped: true, reason: 'forex weekend — breadth suppressed Friday 17:00 to Sunday 17:00 NY' };
  }

  const BREADTH_TF = '1H';
  const now = Date.now();

  // Read 1H candles per pair from the dedicated Yahoo breadth cache —
  // watchdog-worker's fetchBreadthFromYahoo() writes MAJOR_PAIRS here
  // (yahoo_candle_cache), not the shared candle_cache, as of its
  // 2026-08-12 rebuild (Section 14 of the architecture report).
  const pairData = {};
  for (const [pair, base, quote] of MAJOR_PAIRS) {
    const candles = await getYahooCandlesFromCache(pair, BREADTH_TF, env);
    if (candles && candles.length >= 1) {
      pairData[pair] = { candles, base, quote };
    } else {
      debugLog.push(`skip ${pair}: no candles`);
    }
  }

  // Build heatmap and strength from the most recent closed candle.
  const heatmap = {};
  for (const c of BREADTH_CURRENCIES) heatmap[c] = {};

  for (const [pair, { candles, base, quote }] of Object.entries(pairData)) {
    const c   = candles[0];
    const pct = c.open !== 0 ? ((c.close - c.open) / c.open) * 100 : 0;
    heatmap[base][quote] = parseFloat(pct.toFixed(4));
    heatmap[quote][base] = parseFloat((-pct).toFixed(4));
  }

  const strength = {};
  for (const ccy of BREADTH_CURRENCIES) {
    const vals = Object.values(heatmap[ccy]).filter(v => !isNaN(v));
    strength[ccy] = vals.length > 0
      ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4))
      : 0;
  }

  // Write snapshot cache.
  await env.DB.prepare(
    'INSERT OR REPLACE INTO market_breadth_cache (tf, computed_at, heatmap, strength) VALUES (?,?,?,?)'
  ).bind(BREADTH_TF, now, JSON.stringify(heatmap), JSON.stringify(strength)).run();

  // Append intraday snapshot, prune rows older than 40 days. Was 48 hours
  // (still all the /market/breadth route's intraday chart query reads —
  // that query is its own separate 48h-bounded SELECT, unaffected by this
  // retention window), extended so computeWeeklyBreadth() below actually
  // has 5+ weeks of history to aggregate from.
  await env.DB.prepare(
    'INSERT OR REPLACE INTO market_breadth_intraday (tf, snapshot_at, strength) VALUES (?,?,?)'
  ).bind(BREADTH_TF, now, JSON.stringify(strength)).run();
  await env.DB.prepare(
    'DELETE FROM market_breadth_intraday WHERE tf = ? AND snapshot_at < ?'
  ).bind(BREADTH_TF, now - 40 * 24 * 60 * 60 * 1000).run();

  // Build per-candle strength series for correlation (up to 10 points).
  const seriesLen = Math.min(10, ...Object.values(pairData).map(d => d.candles.length));
  const returnSeries = {};
  for (const ccy of BREADTH_CURRENCIES) returnSeries[ccy] = [];

  for (let i = 0; i < seriesLen; i++) {
    const snap = {};
    for (const ccy of BREADTH_CURRENCIES) snap[ccy] = {};
    for (const [pair, { candles, base, quote }] of Object.entries(pairData)) {
      if (i >= candles.length) continue;
      const c   = candles[i];
      const pct = c.open !== 0 ? ((c.close - c.open) / c.open) * 100 : 0;
      snap[base][quote] = pct;
      snap[quote][base] = -pct;
    }
    for (const ccy of BREADTH_CURRENCIES) {
      const vals = Object.values(snap[ccy]).filter(v => !isNaN(v));
      returnSeries[ccy].push(vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
    }
  }

  const matrix = {};
  for (const a of BREADTH_CURRENCIES) {
    matrix[a] = {};
    for (const b of BREADTH_CURRENCIES) {
      matrix[a][b] = a === b ? 1 : parseFloat(pearsonCorr(returnSeries[a], returnSeries[b]).toFixed(3));
    }
  }

  await env.DB.prepare(
    'INSERT OR REPLACE INTO market_breadth_correlation (tf, computed_at, matrix) VALUES (?,?,?)'
  ).bind(BREADTH_TF, now, JSON.stringify(matrix)).run();

  debugLog.push(`breadth ok: ${Object.keys(pairData).length}/28 pairs`);

  await computeWeeklyBreadth(env, debugLog);

  return { pairs_fetched: Object.keys(pairData).length };
}

// ── Weekly Market Breadth aggregation ─────────────────────────
function getIsoWeekKey(tsMs) {
  const d = new Date(tsMs);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Same Thursday-anchor math as getIsoWeekKey, additionally resolved to the
// ISO week's Sunday (date-only, UTC midnight) so "is this week complete"
// can be checked without re-deriving the week boundary a second way.
function getIsoWeekSundayMs(tsMs) {
  const d = new Date(tsMs);
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const mondayMs = thursday.getTime() - 3 * 24 * 60 * 60 * 1000;
  return mondayMs + 6 * 24 * 60 * 60 * 1000;
}

// market_breadth_intraday only stores per-currency `strength`, not a
// pair-level heatmap, so there's nothing to aggregate for a weekly heatmap —
// the '1W' row gets heatmap='{}' (the column is NOT NULL with no default).
async function computeWeeklyBreadth(env, debugLog) {
  const now = Date.now();
  const cutoff = now - 35 * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    'SELECT * FROM market_breadth_intraday WHERE snapshot_at > ? ORDER BY snapshot_at ASC'
  ).bind(cutoff).all();

  const weeks = new Map(); // isoWeekKey -> { sundayMs, days: Set<dayIndex>, rows: [...] }
  for (const row of results ?? []) {
    const key = getIsoWeekKey(row.snapshot_at);
    if (!weeks.has(key)) {
      weeks.set(key, { sundayMs: getIsoWeekSundayMs(row.snapshot_at), days: new Set(), rows: [] });
    }
    const w = weeks.get(key);
    w.days.add(Math.floor(row.snapshot_at / 86400000));
    w.rows.push(row);
  }

  // Most recent completed week only (Sunday end date before today UTC),
  // skipping any week with fewer than 3 distinct trading days.
  const todayUTCms = Math.floor(now / 86400000) * 86400000;
  let latestCompleted = null;
  for (const [key, w] of weeks) {
    if (w.days.size < 3) continue;
    if (w.sundayMs >= todayUTCms) continue; // current/in-progress week
    if (!latestCompleted || w.sundayMs > latestCompleted.sundayMs) {
      latestCompleted = { key, ...w };
    }
  }
  if (!latestCompleted) {
    debugLog.push('weekly breadth: no completed week with >=3 trading days in the last 35 days');
    return;
  }

  const sums = {}, counts = {};
  for (const ccy of BREADTH_CURRENCIES) { sums[ccy] = 0; counts[ccy] = 0; }
  for (const row of latestCompleted.rows) {
    const strength = JSON.parse(row.strength);
    for (const ccy of BREADTH_CURRENCIES) {
      if (typeof strength[ccy] === 'number') { sums[ccy] += strength[ccy]; counts[ccy] += 1; }
    }
  }
  const weeklyStrength = {};
  for (const ccy of BREADTH_CURRENCIES) {
    weeklyStrength[ccy] = counts[ccy] > 0 ? parseFloat((sums[ccy] / counts[ccy]).toFixed(4)) : 0;
  }

  await env.DB.prepare(`
    INSERT INTO market_breadth_cache (tf, computed_at, heatmap, strength)
    VALUES ('1W', ?, '{}', ?)
    ON CONFLICT(tf) DO UPDATE SET computed_at = excluded.computed_at, strength = excluded.strength
  `).bind(now, JSON.stringify(weeklyStrength)).run();

  debugLog.push(`weekly breadth ok: week ${latestCompleted.key}, ${latestCompleted.days.size} trading days`);

  // ── Current in-progress ISO week — running average, no minimum
  // trading-day threshold (unlike the completed-week logic above), so
  // 'this week' reflects however many trading days have elapsed so far.
  // Reuses the `weeks` bucketing already built above — no new D1 read.
  const currentWeekKey = getIsoWeekKey(now);
  const currentWeek = weeks.get(currentWeekKey);
  if (currentWeek && currentWeek.rows.length > 0) {
    const curSums = {}, curCounts = {};
    for (const ccy of BREADTH_CURRENCIES) { curSums[ccy] = 0; curCounts[ccy] = 0; }
    for (const row of currentWeek.rows) {
      const strength = JSON.parse(row.strength);
      for (const ccy of BREADTH_CURRENCIES) {
        if (typeof strength[ccy] === 'number') { curSums[ccy] += strength[ccy]; curCounts[ccy] += 1; }
      }
    }
    const currentWeeklyStrength = {};
    for (const ccy of BREADTH_CURRENCIES) {
      currentWeeklyStrength[ccy] = curCounts[ccy] > 0 ? parseFloat((curSums[ccy] / curCounts[ccy]).toFixed(4)) : 0;
    }

    await env.DB.prepare(`
      INSERT INTO market_breadth_cache (tf, computed_at, heatmap, strength)
      VALUES ('1W_current', ?, '{}', ?)
      ON CONFLICT(tf) DO UPDATE SET computed_at = excluded.computed_at, strength = excluded.strength
    `).bind(now, JSON.stringify(currentWeeklyStrength)).run();

    debugLog.push(`current week breadth ok: week ${currentWeekKey}, ${currentWeek.days.size} trading days so far`);
  } else {
    debugLog.push(`current week breadth: no data yet for week ${currentWeekKey}`);
  }
}

// ── Forex/Crypto SMA Cloud ──────────────────────────────────────
// Runs in compute-worker via POST /cron/sma. Same three-signal design as the
// NSE SMA Cloud revamp (nse-worker/src/nse-cron.js) — phase machine, Type
// 1 (trend initiation), Type 2 (cloud rejection re-entry, CISD/MSS
// confirmed), Exhaustion — ported here against forex/crypto's own tables
// (fvg_zones/swing_states, not the nse_-prefixed ones), NY timestamps
// instead of IST, and no volume gate (OTC — no volume data available).
//
// forex_sma_state is keyed by symbol+timeframe, shared across every user
// configured on that symbol+TF (same design as nse_sma_state). The phase
// machine and its edge-transition flags (justEnteredDistribution /
// justExhausted) are computed ONCE per symbol+TF per cron cycle, then each
// eligible user's own bias_mode/htf_timeframe/confirmation_mode is checked
// against that single shared result — re-deriving the phase inside the
// per-user loop (read priorState → advanceSmaPhase → upsert, once per
// user) would make the edge-transition flags come out false for every user
// after the first, since the first user's upsert would already have
// overwritten the "prior" state by the time the second user's iteration
// re-reads it, silently suppressing their alert. The CISD watch fields
// themselves remain a single shared value with last-write-wins semantics
// when multiple users on the same symbol+TF have different settings — an
// accepted simplification, not something this file tries to fully solve.

const FOREX_SMA_VALID_TFS = ['M15', 'M30', '1H', '4H'];

const FOREX_SMA_WATCH_EXPIRY_MS = {
  'M15': 4 * 60 * 60 * 1000,         // 4H — one HTF window
  'M30': 4 * 60 * 60 * 1000,         // 4H — one HTF window
  '1H':  { '4H': 4 * 60 * 60 * 1000, 'D': 24 * 60 * 60 * 1000 },
  '4H':  24 * 60 * 60 * 1000,        // 1D — one daily window
};

const FOREX_SMA_TYPE2_COOLDOWN_MS = {
  'M15': 4 * 60 * 60 * 1000,
  'M30': 4 * 60 * 60 * 1000,
  '1H':  { '4H': 4 * 60 * 60 * 1000, 'D': 24 * 60 * 60 * 1000 },
  '4H':  24 * 60 * 60 * 1000,
};

const FOREX_SMA_SEPARATION_THRESHOLD = 0.15;  // atr14 * 0.15
const FOREX_SMA_VELOCITY_THRESHOLD   = 0.03;  // atr14 * 0.03
const FOREX_SMA_WICK_PENETRATION     = 0.10;  // atr14 * 0.10

// '1H' maps to an object keyed by htf_timeframe (two valid HTF options);
// every other TF maps to a single duration.
function forexSmaWatchExpiryMs(tf, htfTimeframe) {
  const v = FOREX_SMA_WATCH_EXPIRY_MS[tf];
  return typeof v === 'object' ? (v[htfTimeframe] ?? Object.values(v)[0]) : v;
}
function forexSmaCooldownMs(tf, htfTimeframe) {
  const v = FOREX_SMA_TYPE2_COOLDOWN_MS[tf];
  return typeof v === 'object' ? (v[htfTimeframe] ?? Object.values(v)[0]) : v;
}

// values: oldest-first. Simple moving average, null-padded until `period`
// values have accumulated.
function computeSMA(values, period) {
  const result = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

// ATR — Wilder-smoothed average true range. candles: newest-first.
// Returns a single current-bar ATR value (or null if insufficient data).
function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const oldestFirst = [...candles].reverse();
  const trueRanges = [];
  for (let i = 1; i < oldestFirst.length; i++) {
    const curr = oldestFirst[i];
    const prev = oldestFirst[i - 1];
    trueRanges.push(Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    ));
  }
  if (trueRanges.length < period) return null;

  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

// htfCandles: newest-first, need at least 9. Single current-bar value.
function computeSMAHTF(htfCandles) {
  if (!htfCandles || htfCandles.length < 9) return null;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += htfCandles[i].close;
  return sum / 9;
}

function didSma1x9Crossover(i, sma1Arr, sma9Arr) {
  if (i + 1 >= sma1Arr.length) return false;
  const a = sma1Arr[i], b = sma9Arr[i], c = sma1Arr[i + 1], d = sma9Arr[i + 1];
  if (a == null || b == null || c == null || d == null) return false;
  return (a > b) !== (c > d);
}

function countSma1x9Crossovers(window, sma1Arr, sma9Arr) {
  let count = 0;
  for (let i = 0; i < window; i++) if (didSma1x9Crossover(i, sma1Arr, sma9Arr)) count++;
  return count;
}

// Phase state machine — pure transition function, identical to the NSE SMA
// Cloud revamp. prev: prior forex_sma_state row (or null). m: computed
// metrics for this run.
function advanceSmaPhase(prev, m) {
  const prevPhase     = prev?.phase ?? 'accumulation';
  const prevDirection = prev?.direction ?? null;

  const trendDirection = m.sma1Now > m.sma9Now ? 'bullish'
    : m.sma1Now < m.sma9Now ? 'bearish' : null;
  const isDistributing = trendDirection !== null
    && m.separationNow > (m.atr14 * FOREX_SMA_SEPARATION_THRESHOLD)
    && m.crossover3 === 0;

  const isExhausting = prevPhase === 'distribution'
    && (m.separationNow < (m.atr14 * FOREX_SMA_SEPARATION_THRESHOLD) || m.crossover3 >= 1);

  const freshCross = m.freshCrossBull || m.freshCrossBear;

  let phase, direction, justEnteredDistribution, justExhausted;

  if (isExhausting) {
    phase = 'accumulation';
    direction = null;
    justEnteredDistribution = false;
    justExhausted = true;
  } else if (isDistributing) {
    phase = 'distribution';
    direction = trendDirection;
    justEnteredDistribution = freshCross
      || (prevPhase !== 'distribution')
      || (prevDirection !== trendDirection);
    justExhausted = false;
  } else {
    phase = 'accumulation';
    direction = null;
    justEnteredDistribution = false;
    justExhausted = false;
  }

  return { phase, direction, justEnteredDistribution, justExhausted };
}

// Dual-mode bias gate, forex/crypto version — reads bias_cache/candle_cache/
// daily_candle_cache instead of NSE's tables, otherwise identical logic to
// checkSMABias in nse-cron.js.
// 'none': same-TF TTrades bias, fails open if bias_cache row missing.
// 'htf_sma': close vs SMA9 on the HTF leg, fails open if HTF SMA unavailable.
// 'ttrades' (default): HTF TTrades bias, falling back to HTF SMA when the
// bias_cache row for that HTF is missing this tick.
async function checkForexSMABias(symbol, signalTf, htfTimeframe, biasMode, htfCandles, direction, currentClose, env) {
  if (biasMode === 'none') {
    const row = await env.DB.prepare(
      'SELECT bias FROM bias_cache WHERE symbol = ? AND timeframe = ?'
    ).bind(symbol, signalTf).first();
    if (!row) return { passes: true, label: 'No bias filter' };
    const passes = row.bias === direction;
    return { passes, label: `${signalTf} TTrades` };
  }

  if (biasMode === 'htf_sma') {
    const smaHTFValue = computeSMAHTF(htfCandles);
    if (!smaHTFValue) return { passes: true, label: 'HTF SMA unavailable' };
    const passes = direction === 'bullish' ? currentClose > smaHTFValue : currentClose < smaHTFValue;
    return { passes, label: `HTF SMA ${htfTimeframe}` };
  }

  const row = await env.DB.prepare(
    'SELECT bias FROM bias_cache WHERE symbol = ? AND timeframe = ?'
  ).bind(symbol, htfTimeframe).first();

  if (!row) {
    const smaHTFValue = computeSMAHTF(htfCandles);
    if (!smaHTFValue) return { passes: true, label: 'HTF bias unavailable' };
    const passes = direction === 'bullish' ? currentClose > smaHTFValue : currentClose < smaHTFValue;
    return { passes, label: `HTF SMA ${htfTimeframe} (fallback)` };
  }

  const passes = row.bias === direction;
  return { passes, label: `TTrades ${htfTimeframe}` };
}

// Delivers one forex SMA Cloud alert to one user. Reuses the existing
// isDuplicateAlert dedup guard (ALERT_INTERVAL_MS-keyed) rather than a
// second parallel dedup implementation. trendBias always defaults to
// 'neutral', never null — alert_history.trend_bias is NOT NULL in
// production; passing null throws a D1 constraint error that the caller's
// try/catch swallows, silently dropping the alert_history row (the
// Telegram send has already happened by that point).
async function deliverForexSmaAlert(env, { userId, chatId, symbol, timeframe, direction, candleTime, alertType, trendBias, message }) {
  const isDup = await isDuplicateAlert(env.DB, userId, symbol, timeframe, direction, alertType);
  if (isDup) return false;

  await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId, message);

  await env.DB.prepare(`
    INSERT INTO alert_history (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    crypto.randomUUID(), userId, symbol, timeframe, direction, trendBias ?? 'neutral', candleTime, Date.now(), alertType
  ).run();
  return true;
}

// Main forex/crypto SMA Cloud cron handler.
async function handleForexSmaCron(tf, env, debugLog = null) {
  const log = (msg) => { console.log(msg); if (debugLog) debugLog.push(msg); };
  log(`Forex SMA Cloud trigger → TF: ${tf}`);

  if (!FOREX_SMA_VALID_TFS.includes(tf)) {
    log(`Invalid TF for forex SMA Cloud: ${tf}`);
    return;
  }

  const { results: configs } = await env.DB.prepare(`
    SELECT fic.id as config_id, fic.bias_mode, fic.htf_timeframe, fic.confirmation_mode,
           ua.id as asset_id, ua.symbol,
           u.id as user_id, u.user_tf_access,
           ut.chat_id
    FROM forex_indicator_configs fic
    JOIN user_assets ua ON ua.id = fic.asset_id
    JOIN users u ON u.id = fic.user_id
    LEFT JOIN user_telegram ut ON ut.user_id = fic.user_id AND ut.verified = 1
    WHERE fic.timeframe = ?
      AND fic.enabled = 1
      AND fic.indicator = 'sma'
      AND ua.asset_type IN ('forex', 'crypto', 'commodity')
      AND u.active = 1
  `).bind(tf).all();

  if (!configs?.length) {
    log(`No forex SMA Cloud assets configured for ${tf}`);
    return;
  }

  const symbolMap = new Map();
  for (const row of configs) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, []);
    symbolMap.get(row.symbol).push(row);
  }

  for (const [symbol, userRows] of symbolMap) {
    try {
      const candles = await getCandlesFromCache(symbol, tf, env);
      if (!candles || candles.length < 15) {
        log(`[${symbol}] SKIP: insufficient candles (${candles?.length ?? 0})`);
        continue;
      }

      const sma1 = candles.map(c => c.close); // newest-first, aligned with candles[i]
      const sma9OldestFirst = computeSMA([...candles].reverse().map(c => c.close), 9);
      const sma9 = [...sma9OldestFirst].reverse();

      const atr14 = computeATR(candles, 14);
      if (sma1[0] == null || sma9[0] == null || atr14 == null) {
        log(`[${symbol}] SKIP: ATR/SMA unavailable`);
        continue;
      }
      const validSma9Count = sma9.filter(v => v != null).length;
      if (validSma9Count < 10) {
        log(`[${symbol}] SKIP: insufficient SMA9 history`);
        continue;
      }

      const crossover5 = countSma1x9Crossovers(5, sma1, sma9);
      const crossover3 = countSma1x9Crossovers(3, sma1, sma9);

      const sma1Now = sma1[0];
      const sma9Now = sma9[0];
      const separationNow  = Math.abs(sma1Now - sma9Now);
      const separation5Ago = (sma1[5] != null && sma9[5] != null) ? Math.abs(sma1[5] - sma9[5]) : separationNow;
      const velocityRaw    = (separationNow - separation5Ago) / 5;
      const velocityLabel  = velocityRaw > (atr14 * FOREX_SMA_VELOCITY_THRESHOLD) ? 'Sharp⚡' : 'Gradual📉';

      const cloudTop    = Math.max(sma1Now, sma9Now);
      const cloudBottom = Math.min(sma1Now, sma9Now);

      // Phase advance computed ONCE per symbol+TF — see header note.
      const priorState = await env.DB.prepare(
        'SELECT * FROM forex_sma_state WHERE symbol=? AND timeframe=?'
      ).bind(symbol, tf).first();

      const prevSma1 = priorState?.sma1_last ?? null;
      const prevSma9 = priorState?.sma9_last ?? null;
      const freshCrossBull = prevSma1 != null && prevSma9 != null && prevSma1 <= prevSma9 && sma1Now > sma9Now;
      const freshCrossBear = prevSma1 != null && prevSma9 != null && prevSma1 >= prevSma9 && sma1Now < sma9Now;

      const advance = advanceSmaPhase(priorState, {
        crossover3, crossover5, separationNow, atr14, sma1Now, sma9Now, freshCrossBull, freshCrossBear,
      });

      const bar0 = candles[0];
      let newCisdWatchActive, newCisdWatchDirection, newCisdPullbackStart, newCisdWatchArmedAt;

      if (advance.justExhausted) {
        // ── Exhaustion — no gates, disarms any active watch, precludes Type 1/2 ──
        const nowNY = fmtNY(Date.now());
        const message = [
          `⚠️ <b>SMA Cloud Exhausting — ${symbol}</b>`,
          `⏱ Timeframe: ${tf}`,
          `🕐 Candle: ${nowNY} NY`,
          `━━━━━━━━━━━━━━`,
          `Trend separation collapsed`,
          `━━━━━━━━━━━━━━`,
          `EBP Tracker`,
        ].join('\n');

        for (const row of userRows) {
          const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
          if (!userTfAccess.includes(tf) || !row.chat_id) continue;
          try {
            await deliverForexSmaAlert(env, {
              userId: row.user_id, chatId: row.chat_id, symbol, timeframe: tf,
              direction: priorState?.direction ?? 'bullish', candleTime: bar0.time,
              alertType: 'sma_exhaustion', trendBias: 'neutral', message,
            });
          } catch (e) {
            log(`[${symbol}] exhaustion deliver error user=${row.user_id}: ${e.message}`);
          }
        }

        newCisdWatchActive = 0; newCisdWatchDirection = null;
        newCisdPullbackStart = null; newCisdWatchArmedAt = null;

      } else if (advance.justEnteredDistribution) {
        // ── Type 1 — trend initiation ──
        if (separationNow > atr14 * FOREX_SMA_SEPARATION_THRESHOLD) {
          const fvg = await env.DB.prepare(`
            SELECT id, top, bottom FROM fvg_zones
            WHERE symbol=? AND tf=? AND direction=?
            AND mitigated_at IS NULL AND expires_at > ?
            ORDER BY formed_at DESC LIMIT 1
          `).bind(symbol, tf, advance.direction, new Date().toISOString()).first();

          if (fvg) {
            const nowNY = fmtNY(Date.now());
            for (const row of userRows) {
              const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
              if (!userTfAccess.includes(tf) || !row.chat_id) continue;

              try {
                let htfCandles = null;
                if (row.bias_mode === 'htf_sma') {
                  htfCandles = row.htf_timeframe === 'D'
                    ? await getDailyCandlesFromCache(symbol, env)
                    : await getCandlesFromCache(symbol, row.htf_timeframe, env);
                }
                const bias = await checkForexSMABias(symbol, tf, row.htf_timeframe, row.bias_mode, htfCandles, advance.direction, bar0.close, env);
                if (!bias.passes) continue;

                const message = [
                  `${advance.direction === 'bullish' ? '🟢' : '🔴'} <b>SMA Cloud: ${advance.direction === 'bullish' ? 'Bullish' : 'Bearish'} Trend — ${symbol}</b>`,
                  `⏱ Timeframe: ${tf}`,
                  `🕐 Candle: ${nowNY} NY`,
                  `━━━━━━━━━━━━━━`,
                  `Momentum: ${velocityLabel}`,
                  `SMA1: ${sma1Now.toFixed(5)} · SMA9: ${sma9Now.toFixed(5)}`,
                  `FVG Zone: ${fvg.bottom.toFixed(5)} – ${fvg.top.toFixed(5)}`,
                  `📊 Bias: ${bias.label}`,
                  `━━━━━━━━━━━━━━`,
                  `EBP Tracker`,
                ].join('\n');

                const fired = await deliverForexSmaAlert(env, {
                  userId: row.user_id, chatId: row.chat_id, symbol, timeframe: tf,
                  direction: advance.direction, candleTime: bar0.time,
                  alertType: 'sma_type1', trendBias: bias.label, message,
                });
                if (fired) {
                  await env.DB.prepare(
                    'UPDATE forex_sma_state SET last_signal_date=?, last_signal_time=? WHERE symbol=? AND timeframe=?'
                  ).bind(
                    new Date().toISOString().slice(0, 10), Date.now(), symbol, tf
                  ).run();
                }
              } catch (e) {
                log(`[${symbol}] type1 deliver error user=${row.user_id}: ${e.message}`);
              }
            }
          }
        }
        // Type 1 never touches the CISD watch fields — preserved via priorState fallback below.

      } else if (advance.phase === 'distribution') {
        // ── Type 2 — two-step CISD/MSS re-entry chain ──
        const watchActiveSameDir = priorState?.cisd_watch_active === 1 && priorState?.cisd_watch_direction === advance.direction;

        if (watchActiveSameDir) {
          const watchDirection = priorState.cisd_watch_direction;
          const watchArmedAt   = priorState.cisd_watch_armed_at;
          const pullbackStart  = priorState.cisd_pullback_start;

          // Shared (not user-config-dependent) confirmation detection —
          // computed once, routed per-user by confirmation_mode below.
          const swingState = await env.DB.prepare(
            'SELECT last_confirmed_swing_high, last_confirmed_swing_low, run_dir, run_start_time FROM swing_states WHERE symbol=? AND tf=?'
          ).bind(symbol, tf).first();

          let mssOk = false, cisdOk = false, mssLevel = null, cisdLevel = null;

          if (watchDirection === 'bullish' && swingState?.last_confirmed_swing_high != null) {
            mssOk = bar0.close > swingState.last_confirmed_swing_high;
            mssLevel = swingState.last_confirmed_swing_high;
          } else if (watchDirection === 'bearish' && swingState?.last_confirmed_swing_low != null) {
            mssOk = bar0.close < swingState.last_confirmed_swing_low;
            mssLevel = swingState.last_confirmed_swing_low;
          }

          const pullbackRunActive = watchDirection === 'bullish'
            ? swingState?.run_dir === 'bearish'
            : swingState?.run_dir === 'bullish';

          if (pullbackRunActive && pullbackStart) {
            // pullbackStart is an ISO string (swing_states.run_start_time);
            // candles[i].time is a numeric epoch — must convert before
            // comparing, or the filter silently matches nothing.
            const pullbackStartMs = new Date(pullbackStart).getTime();
            const pullbackCandles = candles.filter(c => c.time >= pullbackStartMs);
            if (pullbackCandles.length > 0) {
              cisdLevel = watchDirection === 'bullish'
                ? Math.max(...pullbackCandles.map(c => c.open))
                : Math.min(...pullbackCandles.map(c => c.open));
              cisdOk = watchDirection === 'bullish'
                ? bar0.close > cisdLevel
                : bar0.close < cisdLevel;
            }
          }

          const nowNY = fmtNY(Date.now());
          const cloudBoundary = watchDirection === 'bullish' ? cloudTop : cloudBottom;
          const wickLevel = watchDirection === 'bullish' ? bar0.low : bar0.high;

          for (const row of userRows) {
            const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
            if (!userTfAccess.includes(tf) || !row.chat_id) continue;

            try {
              const watchExpiryMs = forexSmaWatchExpiryMs(tf, row.htf_timeframe);
              const expired = watchArmedAt && (Date.now() - new Date(watchArmedAt).getTime()) > watchExpiryMs;

              let htfCandles = null;
              if (row.bias_mode === 'htf_sma') {
                htfCandles = row.htf_timeframe === 'D'
                  ? await getDailyCandlesFromCache(symbol, env)
                  : await getCandlesFromCache(symbol, row.htf_timeframe, env);
              }
              const biasForWatch = await checkForexSMABias(symbol, tf, row.htf_timeframe, row.bias_mode, htfCandles, watchDirection, bar0.close, env);
              const biasFlipped = !biasForWatch.passes;

              if (expired || biasFlipped) {
                newCisdWatchActive = 0; newCisdWatchDirection = null;
                newCisdPullbackStart = null; newCisdWatchArmedAt = null;
                continue;
              }

              const confirmationMode = ['mss', 'cisd', 'either'].includes(row.confirmation_mode) ? row.confirmation_mode : 'either';
              const confirmed = confirmationMode === 'mss' ? mssOk
                : confirmationMode === 'cisd' ? cisdOk
                : (mssOk || cisdOk);
              if (!confirmed) continue;

              const cooldownMs = forexSmaCooldownMs(tf, row.htf_timeframe);
              const lastSignalTime = priorState?.last_signal_time ?? 0;
              const cooldownOk = (Date.now() - lastSignalTime) > cooldownMs;

              if (cooldownOk) {
                const confirmLine = mssOk && mssLevel != null
                  ? `MSS: ${watchDirection === 'bullish' ? 'Swing high reclaimed' : 'Swing low broken'}: ${mssLevel.toFixed(5)}`
                  : cisdOk && cisdLevel != null
                  ? `CISD: Run open reclaimed: ${cisdLevel.toFixed(5)}`
                  : '';

                const message = [
                  `${watchDirection === 'bullish' ? '🟢' : '🔴'} <b>SMA Cloud: ${watchDirection === 'bullish' ? 'Bullish' : 'Bearish'} Re-entry — ${symbol}</b>`,
                  `⏱ Timeframe: ${tf}`,
                  `🕐 Candle: ${nowNY} NY`,
                  `━━━━━━━━━━━━━━`,
                  `Rejected from cloud: ${cloudBoundary.toFixed(5)}`,
                  `Wick ${watchDirection === 'bullish' ? 'low' : 'high'}: ${wickLevel.toFixed(5)}`,
                  confirmLine,
                  `📊 Bias: ${biasForWatch.label}`,
                  `━━━━━━━━━━━━━━`,
                  `EBP Tracker`,
                ].filter(Boolean).join('\n');

                const fired = await deliverForexSmaAlert(env, {
                  userId: row.user_id, chatId: row.chat_id, symbol, timeframe: tf,
                  direction: watchDirection, candleTime: bar0.time,
                  alertType: 'sma_type2', trendBias: biasForWatch.label, message,
                });
                if (fired) {
                  await env.DB.prepare(
                    'UPDATE forex_sma_state SET last_signal_date=?, last_signal_time=? WHERE symbol=? AND timeframe=?'
                  ).bind(
                    new Date().toISOString().slice(0, 10), Date.now(), symbol, tf
                  ).run();
                }
              }

              // Confirmation happened either way — disarm regardless of
              // whether cooldown blocked the actual notification.
              newCisdWatchActive = 0; newCisdWatchDirection = null;
              newCisdPullbackStart = null; newCisdWatchArmedAt = null;
            } catch (e) {
              log(`[${symbol}] type2 confirm error user=${row.user_id}: ${e.message}`);
            }
          }

        } else {
          // ── Arm — shared price-action gates computed once, bias per-user ──
          const wickedIntoBull = bar0.low < cloudTop && bar0.low > cloudBottom && (cloudTop - bar0.low) >= (atr14 * FOREX_SMA_WICK_PENETRATION);
          const wickedIntoBear = bar0.high > cloudBottom && bar0.high < cloudTop && (bar0.high - cloudBottom) >= (atr14 * FOREX_SMA_WICK_PENETRATION);
          const wickedInto = advance.direction === 'bullish' ? wickedIntoBull : wickedIntoBear;

          const rejectedBull = bar0.close > cloudTop;
          const rejectedBear = bar0.close < cloudBottom;
          const rejected = advance.direction === 'bullish' ? rejectedBull : rejectedBear;

          if (wickedInto && rejected) {
            const swingState = await env.DB.prepare(
              'SELECT run_start_time FROM swing_states WHERE symbol=? AND tf=?'
            ).bind(symbol, tf).first();

            // The values written on arm (direction, pullback start) don't
            // vary by user — only whether bias passes does — so the first
            // user whose bias passes is enough; further users would write
            // identical values.
            for (const row of userRows) {
              try {
                let htfCandles = null;
                if (row.bias_mode === 'htf_sma') {
                  htfCandles = row.htf_timeframe === 'D'
                    ? await getDailyCandlesFromCache(symbol, env)
                    : await getCandlesFromCache(symbol, row.htf_timeframe, env);
                }
                const bias = await checkForexSMABias(symbol, tf, row.htf_timeframe, row.bias_mode, htfCandles, advance.direction, bar0.close, env);
                if (!bias.passes) continue;

                newCisdWatchActive    = 1;
                newCisdWatchDirection = advance.direction;
                newCisdPullbackStart  = swingState?.run_start_time ?? null;
                newCisdWatchArmedAt   = new Date().toISOString();
                break;
              } catch (e) {
                log(`[${symbol}] arm check error user=${row.user_id}: ${e.message}`);
              }
            }
          }
        }
      }

      // ── State upsert — always runs once per symbol+TF ──
      const cisdWatchActive    = newCisdWatchActive    ?? priorState?.cisd_watch_active    ?? 0;
      const cisdWatchDirection = newCisdWatchDirection ?? priorState?.cisd_watch_direction ?? null;
      const cisdPullbackStart  = newCisdPullbackStart  ?? priorState?.cisd_pullback_start  ?? null;
      const cisdWatchArmedAt   = newCisdWatchArmedAt   ?? priorState?.cisd_watch_armed_at  ?? null;

      const distributionStartedAt = advance.justEnteredDistribution
        ? new Date().toISOString()
        : advance.justExhausted
        ? null
        : (priorState?.distribution_started_at ?? null);

      await env.DB.prepare(`
        INSERT INTO forex_sma_state (
          symbol, timeframe, direction, phase, stack_active, consecutive_widening,
          separation, velocity_label, atr14, cloud_top, cloud_bottom,
          sma1_last, sma9_last, distribution_started_at,
          last_signal_date, last_signal_time,
          cisd_watch_active, cisd_watch_direction, cisd_pullback_start, cisd_watch_armed_at,
          updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, timeframe) DO UPDATE SET
          direction               = excluded.direction,
          phase                   = excluded.phase,
          stack_active            = excluded.stack_active,
          consecutive_widening    = 0,
          separation              = excluded.separation,
          velocity_label          = excluded.velocity_label,
          atr14                   = excluded.atr14,
          cloud_top               = excluded.cloud_top,
          cloud_bottom            = excluded.cloud_bottom,
          sma1_last               = excluded.sma1_last,
          sma9_last               = excluded.sma9_last,
          distribution_started_at = excluded.distribution_started_at,
          cisd_watch_active       = excluded.cisd_watch_active,
          cisd_watch_direction    = excluded.cisd_watch_direction,
          cisd_pullback_start     = excluded.cisd_pullback_start,
          cisd_watch_armed_at     = excluded.cisd_watch_armed_at,
          updated_at               = excluded.updated_at
          -- last_signal_date and last_signal_time intentionally absent —
          -- updated separately above when a signal actually fires
      `).bind(
        symbol, tf,
        advance.direction,
        advance.phase,
        advance.phase === 'distribution' ? 1 : 0,
        0,
        separationNow,
        velocityLabel,
        atr14,
        cloudTop, cloudBottom,
        sma1Now, sma9Now,
        distributionStartedAt,
        priorState?.last_signal_date ?? null,
        priorState?.last_signal_time ?? null,
        cisdWatchActive, cisdWatchDirection, cisdPullbackStart, cisdWatchArmedAt,
        new Date().toISOString()
      ).run();

      log(`[${symbol}] phase=${advance.phase} direction=${advance.direction ?? 'none'}`);
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      log(`[${symbol}] ERROR: ${err.message}`);
      console.error(err.stack);
    }
  }

  log(`Forex SMA Cloud cron complete for ${tf}`);
}

// ============================================================
// Main fetch / scheduled handlers
// ============================================================

async function handleFetch(request, env) {
  const origin   = request.headers.get('Origin') ?? '';
  const url      = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // ── Health check — public ────────────────────────────────────
  if (pathname === '/health') {
    return json({ status: 'ok', worker: 'compute-worker' }, 200, origin);
  }

  // ── Forex/Crypto SMA Cloud cron trigger — secured by X-Cron-Secret ───
  // Called by cron-job.org on schedule
  if (pathname === '/cron/sma' && request.method === 'POST') {
    const secret = request.headers.get('X-Cron-Secret');
    if (!secret || secret !== env.CRON_SECRET) {
      return json({ error: 'Forbidden' }, 403, origin);
    }

    let body = {};
    try { body = await request.json(); } catch {}

    const tf = body.tf;

    if (!FOREX_SMA_VALID_TFS.includes(tf)) {
      return json({ error: `Invalid TF: ${tf}. Must be one of ${FOREX_SMA_VALID_TFS.join(', ')}` }, 400, origin);
    }

    try {
      const debugLog = [];
      await handleForexSmaCron(tf, env, debugLog);
      return json({
        ok: true,
        tf,
        fired_at: new Date().toISOString(),
        debug: debugLog,
      }, 200, origin);
    } catch (err) {
      console.error(`SMA cron trigger error TF=${tf}:`, err.message);
      return json({ error: err.message, stack: err.stack }, 500, origin);
    }
  }

  return json({ error: 'Not found', worker: 'compute-worker' }, 404, origin);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      console.error('Unhandled fetch error:', err.message);
      return new Response(
        JSON.stringify({ error: 'Internal server error', detail: err.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },

  // Market Breadth CF native cron — fires at :05 every hour (see
  // wrangler.toml [triggers]). Forex SMA Cloud cron remains on
  // cron-job.org (POST /cron/sma).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleMarketBreadthCron(env));
  },
};
