// ============================================================
// EBP Tracker Worker — Zero Dependencies Bundle
// Uses native Workers fetch API only — no npm imports
// Compatible with Cloudflare dashboard editor deployment
// ============================================================

// ============================================================
// CORS helper
// ============================================================
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://ebp-tracker.pages.dev',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
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

function getOrigin(request) {
  return request.headers.get('Origin') ?? '';
}

// Trade Journal is a separate browser app on its own origin, not in
// ALLOWED_ORIGINS — /signals routes are secured by X-Journal-Secret instead
// of an origin allowlist, so they need open CORS rather than corsHeaders().
function journalJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// ============================================================
// Router
// ============================================================
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, path, ...handlers) {
    this.routes.push({ method, path, handlers });
  }

  get(path, ...handlers)    { this.add('GET',    path, ...handlers); }
  post(path, ...handlers)   { this.add('POST',   path, ...handlers); }
  patch(path, ...handlers)  { this.add('PATCH',  path, ...handlers); }
  delete(path, ...handlers) { this.add('DELETE', path, ...handlers); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.path, pathname);
      if (params !== null) return { handlers: route.handlers, params };
    }
    return null;
  }
}

function matchPath(pattern, pathname) {
  const patParts = pattern.split('/');
  const urlParts = pathname.split('/');
  if (patParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

// ============================================================
// TTrades Closure Bias Engine
// ============================================================
function calcTTradesBias({ bar1, bar2 }) {
  const c0    = bar1.close;
  const h0    = bar1.high;
  const l0    = bar1.low;
  const prevH = bar2.high;
  const prevL = bar2.low;

  const sweptH   = h0 > prevH && c0 <= prevH;
  const sweptL   = l0 < prevL && c0 >= prevL;
  const insideD  = h0 <= prevH && l0 >= prevL;
  const outsideD = h0 > prevH && l0 < prevL;
  const aboveH   = c0 > prevH;
  const belowL   = c0 < prevL;

  let closure;
  if (outsideD)      closure = 'outside_bar';
  else if (insideD)  closure = 'inside_bar';
  else if (sweptH)   closure = 'swept_high_closed_inside';
  else if (sweptL)   closure = 'swept_low_closed_inside';
  else if (aboveH)   closure = 'above_prev_high';
  else if (belowL)   closure = 'below_prev_low';
  else               closure = 'none';

  const rng      = h0 - l0;
  const closePos = rng !== 0 ? ((c0 - l0) / rng) * 100 : 50;

  let bias;
  if (closure === 'above_prev_high' || closure === 'swept_low_closed_inside') {
    bias = 'bullish';
  } else if (closure === 'below_prev_low' || closure === 'swept_high_closed_inside') {
    bias = 'bearish';
  } else if (closure === 'outside_bar') {
    bias = closePos >= 50 ? 'bullish' : 'bearish';
  } else {
    bias = 'neutral';
  }

  return { bias, closure, closePos };
}

// ── Bias Source Map ─────────────────────────────────
const BIAS_SOURCE = {
  ebp:      { 'M15': '4H', '1H': 'D', '4H': 'W', 'D': 'W', 'W': null },
  sweep:    { 'M5': '1H', 'M15': '1H', 'M30': '4H', '1H': 'D', '4H': 'W' },
  template: { 'W': null, 'D': 'W', '4H': 'D', '1H': '4H' },
};

// HTF bias display label, keyed by the ACTUAL bias timeframe used for a
// given alert (not the signal's own tf) — necessary since per-user
// htf_override means different users on the same symbol+tf can have a
// different HTF bias source.
function getHTFBiasLabel(biasTF) {
  const map = { '4H': '4H HTF bias', 'D': '1D HTF bias', 'W': '1W HTF bias', '1H': '1H HTF bias' };
  return map[biasTF] ?? `${biasTF} HTF bias`;
}

// User-configurable HTF bias pairing — must match frontend/src/lib/constants.js's
// HTF_OVERRIDE_OPTIONS exactly, or the PATCH below 400s on every attempt to
// set an override for a TF the frontend offers but this list doesn't.
const VALID_HTF_OVERRIDES = {
  'M15': ['4H', '1H'],
  'M30': ['4H'],
  '1H':  ['4H', 'D'],
  '4H':  ['D', 'W'],
  'D':   ['W'],
};

function resolveHTF(signalType, tf, htfOverride) {
  if (htfOverride) return htfOverride;
  return BIAS_SOURCE[signalType][tf] ?? null;
}

function getEffectiveBias(biasTF, biasCache, biasOverrides) {
  if (!biasTF) return 'neutral';
  const override = biasOverrides?.[biasTF];
  if (override && override !== 'auto') return override;
  return biasCache?.[biasTF]?.bias ?? 'neutral';
}

async function writeBiasCache(db, symbol, biasTF, biasResult) {
  await db.prepare(`
    INSERT OR REPLACE INTO bias_cache
    (symbol, timeframe, bias, closure_type, close_pos, bar1_time, updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).bind(
    symbol, biasTF, biasResult.bias, biasResult.closure,
    biasResult.closePos ?? null, biasResult.bar1Time, Date.now()
  ).run();
}

// ── Chain State Machine (T1/T2/T3/T4) ───────────────
// chain_state schema: template_type/state (TEXT state machine), asset_id
// (user_templates and the asset-delete cascade at DELETE /user/assets/:id
// are both asset_id-keyed), direction always 'bullish'/'bearish' (never
// 'bull'/'bear' — matches every detector in this codebase so cross-table
// direction comparisons need no translation layer).

function endOfUTCMonthISO() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)).toISOString();
}

/**
 * Returns ISO string for end of current UTC week (Friday 23:59:59 UTC).
 * Used for T1, T2, T3, T4 chain expiry.
 */
function endOfUTCWeekISO() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon ... 5=Fri, 6=Sat
  const daysUntilFriday = (5 - day + 7) % 7 || 7; // always next Friday if today is Friday
  const friday = new Date(now);
  friday.setUTCDate(now.getUTCDate() + daysUntilFriday);
  friday.setUTCHours(23, 59, 59, 0);
  return friday.toISOString();
}

const TF_INTERVAL_MS = {
  M15: 15 * 60 * 1000, M30: 30 * 60 * 1000, '1H': 60 * 60 * 1000,
  '4H': 4 * 60 * 60 * 1000, D: 24 * 60 * 60 * 1000, W: 7 * 24 * 60 * 60 * 1000,
};

async function insertChain(db, {
  templateType, userId, assetId, symbol, htf, ltf, direction, state, step1SignalId, expiresAt, htfCandle,
  htfHigh, htfLow, htfCandleOpenTime, htfCandleCloseTime, oteTop, oteBottom, zoneType,
  signalId, step, oteEnabled, sweepRequired, triggerType, s1Sent,
}) {
  const nowISO = new Date().toISOString();
  await db.prepare(`
    INSERT INTO chain_state
    (template_type,user_id,asset_id,symbol,htf,ltf,direction,state,step1_signal_id,
     htf_candle_open,htf_candle_close,htf_candle_open_time,htf_candle_close_time,
     expires_at,created_at,
     htf_high,htf_low,ote_top,ote_bottom,zone_type,
     signal_id,step,ote_enabled,sweep_required,trigger_type,s1_sent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    templateType, userId, assetId, symbol, htf, ltf, direction, state, step1SignalId ?? null,
    htfCandle?.open ?? null, htfCandle?.close ?? null,
    // T2's only current caller passes these nested inside htfCandle; T1
    // (new spec) passes them flat — flat wins if both are somehow present.
    htfCandleOpenTime ?? htfCandle?.openTime ?? null,
    htfCandleCloseTime ?? htfCandle?.closeTime ?? null,
    expiresAt, nowISO,
    htfHigh ?? null, htfLow ?? null, oteTop ?? null, oteBottom ?? null, zoneType ?? null,
    signalId ?? null, step ?? 1, oteEnabled ?? 1, sweepRequired ?? 0, triggerType ?? 'cisd',
    s1Sent ? 1 : 0
  ).run();
}

/**
 * T2 S1 alert — sent at EBP fire only when user has no EBP alert enabled.
 * Informs user that T2 chain has been armed and is watching for zone entry.
 */
function formatT2S1Alert({ symbol, htf, ltf, direction, zoneTop, zoneBottom,
                           zoneType, triggerType, signalId }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T2' : 'Bearish T2';
  const zoneLabel = zoneType === 'ote' ? 'OTE Zone' :
                    zoneType === 'discount' ? 'Discount Zone' : 'Premium Zone';
  return `${emoji} <b>${label} Armed — ${symbol}</b>
⏱ HTF: ${htf} → LTF: ${ltf}
━━━━━━━━━━━━━━
🔍 Watching: ${zoneLabel}
📊 Zone: ${zoneBottom.toFixed(5)} – ${zoneTop.toFixed(5)}
⚡ Trigger: ${triggerType.toUpperCase()}
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}/S1
EBP Tracker`;
}

function formatT3S1Alert({ symbol, ltf, direction, zoneTop, zoneBottom,
                           target, triggerType, signalId }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T3' : 'Bearish T3';
  const targetLabel = direction === 'bullish'
    ? 'Target (Prev Day High)' : 'Target (Prev Day Low)';
  return `${emoji} <b>${label} Armed — ${symbol}</b>
⏱ LTF: ${ltf}
━━━━━━━━━━━━━━
📍 Zone (50–75%): ${zoneBottom.toFixed(5)} – ${zoneTop.toFixed(5)}
🎯 ${targetLabel}: ${target.toFixed(5)}
⚡ Trigger: ${triggerType.toUpperCase()}
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}/S1
EBP Tracker`;
}

// ============================================================
// Data Feed — symbol translation only. Candle fetching from Twelve
// Data / Yahoo is Watchdog Worker's job now; EBP Worker reads
// candle_cache / daily_candle_cache / weekly_candle_cache (D1) only.
// ============================================================
function toYahooSymbol(symbol) {
  const overrides = {
    'XAU/USD': 'GC=F', 'XAG/USD': 'SI=F',
    'WTI/USD': 'CL=F', 'BRENT/USD': 'BZ=F',
    'SPX': '^GSPC', 'DJI': '^DJI', 'NDX': '^NDX',
    'NIFTY': '^NSEI', 'SENSEX': '^BSESN',
  };
  if (overrides[symbol]) return overrides[symbol];
  if (symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    return `${base}${quote}=X`;
  }
  return symbol;
}

// ============================================================
// Candle Cache reads — Watchdog Worker is the sole Twelve Data /
// Yahoo caller and the sole writer of candle_cache /
// daily_candle_cache / weekly_candle_cache. EBP Worker only reads.
// ============================================================

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

// daily_candle_cache / weekly_candle_cache store OHLC + a calendar date
// string, not a candle-open timestamp — but detectEBP/updateSwingState and
// the alert formatters all key off bar.time. Reconstruct it from the
// trading-day boundary (17:00 NY the prior calendar day), matching how
// Watchdog derives date_ny/week_start_ny in the first place.
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

// NOTE: FVG detection on D/W timeframes requires 3+ candles.
// daily_candle_cache and weekly_candle_cache accumulate via
// Watchdog synthesis after first deploy. FVG-on-D/W has a
// natural ramp-up of a few days (D) and weeks (W) before
// it fires. EBP and MSS detection on D/W work from day one
// as they only require 2 candles.

// Returns up to 5 daily candles, newest-first — same shape/order EBP
// detection already expects from the old fetchSynthesizedDailyBars path.
async function getDailyCandlesFromCache(symbol, env) {
  const { results } = await env.DB.prepare(
    'SELECT date_ny, open, high, low, close FROM daily_candle_cache WHERE symbol = ? ORDER BY date_ny DESC LIMIT 5'
  ).bind(symbol).all();
  return (results ?? []).map(r => ({
    open: r.open, high: r.high, low: r.low, close: r.close,
    time: nyDateAtHourToUTCms(addDaysToDateStr(r.date_ny, -1), 17),
  }));
}

// Returns up to 5 weekly candles, newest-first.
async function getWeeklyCandlesFromCache(symbol, env) {
  const { results } = await env.DB.prepare(
    'SELECT week_start_ny, week_end_ny, open, high, low, close FROM weekly_candle_cache WHERE symbol = ? ORDER BY week_start_ny DESC LIMIT 5'
  ).bind(symbol).all();
  return (results ?? []).map(r => ({
    open: r.open, high: r.high, low: r.low, close: r.close,
    time: nyDateAtHourToUTCms(addDaysToDateStr(r.week_start_ny, -1), 17),
  }));
}

// Bare 6-char pairs (GBPUSD, XAUUSD, ...) fall through Twelve Data/Yahoo
// unchanged — toYahooSymbol() only translates slash-delimited symbols.
// Normalise to BASE/QUOTE so those lookups actually resolve.
function normaliseSymbol(symbol) {
  if (!symbol) return symbol;
  if (symbol.includes('/')) return symbol; // already slash format

  const FOREX_BASES  = ['EUR', 'GBP', 'USD', 'AUD', 'NZD', 'CAD', 'CHF', 'JPY', 'XAU', 'XAG', 'BTC', 'ETH', 'SOL'];
  const FOREX_QUOTES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

  const upper = symbol.toUpperCase();

  for (const base of FOREX_BASES) {
    for (const quote of FOREX_QUOTES) {
      if (upper === base + quote && base !== quote) {
        return `${base}/${quote}`;
      }
    }
  }

  return symbol; // NSE stocks / indices etc. — passthrough
}

// String-only heuristic — used when the Twelve Data key pool is exhausted
// or its symbol_search request fails outright. Kept deliberately conservative.
function guessAssetType(symbol) {
  if (symbol.includes('/')) {
    const base = symbol.split('/')[0];
    if (['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'BNB'].includes(base)) return 'crypto';
    if (['XAU', 'XAG', 'WTI', 'BRENT'].includes(base)) return 'commodity';
    return 'forex';
  }
  if (symbol.endsWith('.NS') || symbol.endsWith('.BSE')) return 'nse';
  if (['NIFTY', 'SENSEX', 'SPX', 'DJI', 'NDX'].includes(symbol)) return 'index';
  return 'forex';
}

async function validateSymbol(symbol) {
  // Yahoo Finance only — preserves Twelve Data quota for candle fetching
  try {
    const yahooSymbol = toYahooSymbol(symbol);
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + yahooSymbol + '?interval=1d&range=5d';
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (result?.meta?.symbol) return { valid: true, source: 'yahoo', instrumentType: result.meta.instrumentType ?? null };
  } catch (e) {
    console.warn('Yahoo validation failed:', e.message);
  }
  return { valid: true, source: 'fallback', instrumentType: null };
}

// ============================================================
// Telegram
// ============================================================
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

// fired_at is stored as a TEXT ISO 8601 string (migration 013, 2026-08-06 —
// was an INTEGER ms epoch before) — the cutoff bound here must match that
// type, or SQLite's storage-class comparison rules (TEXT always compares
// greater than INTEGER/REAL regardless of content) make every comparison
// against this column silently true instead of silently false.
async function isDuplicateAlert(db, userId, symbol, tf, direction, alertType) {
  const windowMs = ALERT_INTERVAL_MS[tf] || 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - windowMs).toISOString();

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
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit',
    month: 'short', day: 'numeric',
  });
}

// ── Trading session at signal fire time ─────
function deriveSession(firedAtISO) {
  const date = new Date(firedAtISO);

  function isDST(d) {
    const year = d.getUTCFullYear();
    const march = new Date(Date.UTC(year, 2, 1));
    const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - march.getUTCDay()) % 7));
    const nov = new Date(Date.UTC(year, 10, 1));
    const dstEnd = new Date(Date.UTC(year, 10, (7 - nov.getUTCDay()) % 7 + 1));
    dstStart.setUTCHours(7);
    dstEnd.setUTCHours(6);
    return d >= dstStart && d < dstEnd;
  }

  const offset = isDST(date) ? 4 : 5;
  const nyHour = (date.getUTCHours() - offset + 24) % 24;
  const nyMinute = date.getUTCMinutes();
  const nyTime = nyHour + nyMinute / 60;

  if (nyTime >= 20) return 'Asian';        // 20:00–00:00 NY
  if (nyTime >= 7  && nyTime < 10) return 'New York';  // 07:00–10:00 NY
  if (nyTime >= 2  && nyTime < 5)  return 'London';    // 02:00–05:00 NY
  return 'Off-hours';
}

function formatEBPAlert({ symbol, tf, direction, candleTime, trendBias, trendAligned, sweptLevel, closedLevel, signalId, biasTF }) {
  const emoji     = direction === 'bullish' ? '🟢' : '🔴';
  const label     = direction === 'bullish' ? 'BULLISH EBP' : 'BEARISH EBP';
  const alignMark = trendAligned ? '✅' : '⚠️ No Trend Filter';
  const swept     = direction === 'bullish' ? 'Low swept' : 'High swept';
  const closed    = direction === 'bullish' ? 'Closed above body' : 'Closed below body';
  return `${emoji} <b>${label} — ${symbol}</b>
⏱ Timeframe: ${tf}
🕐 Candle: ${fmtNY(candleTime)} NY
📊 Trend: ${trendBias} (${getHTFBiasLabel(biasTF)}) ${alignMark}
━━━━━━━━━━━━━━
${swept}: ${sweptLevel}
${closed}: ${closedLevel}
━━━━━━━━━━━━━━${signalId ? `\n🔗 Signal ID: ${signalId}` : ''}
<i>EBP Tracker</i>`;
}

// ============================================================
// EBP Detection
// ============================================================
function detectEBP(candles) {
  if (!candles || candles.length < 2) return null;
  const bar0 = candles[0];
  const bar1 = candles[1];
  const prevBodyHigh = Math.max(bar1.open, bar1.close);
  const prevBodyLow  = Math.min(bar1.open, bar1.close);
  const bullEBP = bar0.low  < bar1.low  && bar0.close > prevBodyHigh;
  const bearEBP = bar0.high > bar1.high && bar0.close < prevBodyLow;
  if (!bullEBP && !bearEBP) return null;
  return {
    direction:   bullEBP ? 'bullish' : 'bearish',
    candleTime:  bar0.time,
    sweptLevel:  bullEBP ? bar1.low  : bar1.high,
    closedLevel: bar0.close,
  };
}

// Used by /sweep/dashboard (moved from Sweep Worker), which re-runs
// detection live at request time against cached candles rather than
// reading a precomputed sweep-state table.
function detectSweep(candles) {
  if (!candles || candles.length < 2) return null;
  const bar0 = candles[0];
  const bar1 = candles[1];
  const bullSweep = bar0.low  < bar1.low  && bar0.close > bar1.low;
  const bearSweep = bar0.high > bar1.high && bar0.close < bar1.high;
  if (!bullSweep && !bearSweep) return null;
  return {
    direction:         bullSweep ? 'bullish' : 'bearish',
    candleTime:        bar0.time,
    sweptLevel:        bullSweep ? bar1.low   : bar1.high,
    closedInsideLevel: bar0.close,
    prevHigh:          bar1.high,
    prevLow:           bar1.low,
  };
}

// ============================================================
// FVG Engine
// ============================================================

// candles: oldest-first. Gap is between bar[i-2] and bar[i] — the middle
// bar (bar[i-1]) is the impulse candle and isn't itself compared.
function detectFVG(candles) {
  if (!candles || candles.length < 3) return null;
  const barIMinus2 = candles[candles.length - 3];
  const barI       = candles[candles.length - 1];
  if (barIMinus2.high < barI.low) {
    const top = barI.low, bottom = barIMinus2.high;
    return { direction: 'bullish', top, bottom, midpoint: (top + bottom) / 2, formed_at: barI.time };
  }
  if (barIMinus2.low > barI.high) {
    const top = barIMinus2.low, bottom = barI.high;
    return { direction: 'bearish', top, bottom, midpoint: (top + bottom) / 2, formed_at: barI.time };
  }
  return null;
}

// 50% fill + body close beyond midpoint.
function checkFVGMitigation(bar, fvgRow) {
  if (fvgRow.direction === 'bullish') return bar.close < fvgRow.midpoint;
  return bar.close > fvgRow.midpoint;
}

// table: 'fvg_zones' | 'nse_fvg_zones'. candlesOldestFirst is the existing
// 3-item [older, prior, current] window already threaded through this file.
async function processFVGZones(db, table, symbol, tf, candlesOldestFirst, latestBar) {
  const nowISO = new Date().toISOString();

  const fvg = detectFVG(candlesOldestFirst);
  if (fvg) {
    // Dedup guard: skip if an active zone with the same direction already
    // overlaps this price range.
    const existing = await db.prepare(
      `SELECT id FROM ${table} WHERE symbol=? AND tf=? AND direction=? AND mitigated_at IS NULL AND expires_at > ?
       AND top >= ? AND bottom <= ? LIMIT 1`
    ).bind(symbol, tf, fvg.direction, nowISO, fvg.bottom, fvg.top).first();

    if (!existing) {
      const formedAtISO = new Date(fvg.formed_at).toISOString();
      const expiresAt   = new Date(fvg.formed_at + 14 * 24 * 60 * 60 * 1000).toISOString();
      await db.prepare(
        `INSERT INTO ${table} (symbol, tf, direction, top, bottom, midpoint, formed_at, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(symbol, tf, fvg.direction, fvg.top, fvg.bottom, fvg.midpoint, formedAtISO, expiresAt, nowISO).run();
    }
  }

  const { results: activeFVGs } = await db.prepare(
    `SELECT * FROM ${table} WHERE symbol=? AND tf=? AND mitigated_at IS NULL AND expires_at > ?`
  ).bind(symbol, tf, nowISO).all();

  for (const row of activeFVGs ?? []) {
    if (checkFVGMitigation(latestBar, row)) {
      await db.prepare(`UPDATE ${table} SET mitigated_at=?, mitigated_by_tf=? WHERE id=?`)
        .bind(nowISO, tf, row.id).run();
    }
  }
}

// ============================================================
// Swing State + MSS Engine
// ============================================================

function isDoji(bar, dojiThreshold) {
  return Math.abs(bar.close - bar.open) <= dojiThreshold;
}

// Real ATR(14) when enough history is passed in; the D1 candle cache this
// file reads from only ever exposes the 3-bar window already used
// elsewhere here, so this returns null in practice and callers fall back
// to (high-low)*0.1 — kept so it activates automatically if the cache is
// ever widened.
function calcATR14(candlesOldestFirst) {
  if (!candlesOldestFirst || candlesOldestFirst.length < 14) return null;
  const bars = candlesOldestFirst.slice(-14);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const prevClose = i > 0 ? bars[i - 1].close : bar.open;
    sum += Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  }
  return sum / bars.length;
}

function detectMSS(bar, swingState) {
  if (!swingState || swingState.run_dir == null || (swingState.run_candle_count ?? 0) < 3) return null;
  if (swingState.run_dir === 'bearish' && swingState.last_confirmed_swing_high != null && bar.close > swingState.last_confirmed_swing_high) {
    return { direction: 'bullish', level: swingState.last_confirmed_swing_high, candle_time: bar.time };
  }
  if (swingState.run_dir === 'bullish' && swingState.last_confirmed_swing_low != null && bar.close < swingState.last_confirmed_swing_low) {
    return { direction: 'bearish', level: swingState.last_confirmed_swing_low, candle_time: bar.time };
  }
  return null;
}

// table: 'swing_states' | 'nse_swing_states'. Only the newest bar
// (candlesOldestFirst's last element) is a genuinely new close each cron
// cycle — the array's second-to-last element is used only as the
// comparison bar when bootstrapping run_dir from empty state.
async function updateSwingState(db, table, symbol, tf, candlesOldestFirst) {
  const bar     = candlesOldestFirst[candlesOldestFirst.length - 1];
  const prevBar = candlesOldestFirst[candlesOldestFirst.length - 2] ?? null;
  const nowISO  = new Date().toISOString();

  let state = await db.prepare(`SELECT * FROM ${table} WHERE symbol=? AND tf=?`).bind(symbol, tf).first();
  if (!state) {
    state = {
      run_dir: null, run_start_time: null, run_candle_count: 0,
      last_confirmed_swing_high: null, last_confirmed_swing_high_time: null,
      last_confirmed_swing_low: null, last_confirmed_swing_low_time: null,
      pending_swing_high: null, pending_swing_high_time: null,
      pending_swing_low: null, pending_swing_low_time: null,
    };
  }

  const atr14         = calcATR14(candlesOldestFirst);
  const dojiThreshold = atr14 != null ? atr14 * 0.1 : (bar.high - bar.low) * 0.1;

  let mssResult = null;
  if (!isDoji(bar, dojiThreshold)) {
    const barTimeISO = new Date(bar.time).toISOString();

    if (state.run_dir === null) {
      if (prevBar && bar.close > prevBar.high)      state.run_dir = 'bullish';
      else if (prevBar && bar.close < prevBar.low)  state.run_dir = 'bearish';
      else                                           state.run_dir = 'bullish';
      state.run_start_time   = barTimeISO;
      state.run_candle_count = 1;
    } else if (state.run_dir === 'bullish') {
      if (bar.high > (state.pending_swing_high ?? -Infinity)) {
        state.pending_swing_high      = bar.high;
        state.pending_swing_high_time = barTimeISO;
      }
      if (state.pending_swing_high != null && bar.close < state.pending_swing_high) {
        state.last_confirmed_swing_high      = state.pending_swing_high;
        state.last_confirmed_swing_high_time = state.pending_swing_high_time;
        state.pending_swing_high      = null;
        state.pending_swing_high_time = null;
      }
      state.run_candle_count = (state.run_candle_count ?? 0) + 1;
    } else {
      if (bar.low < (state.pending_swing_low ?? Infinity)) {
        state.pending_swing_low      = bar.low;
        state.pending_swing_low_time = barTimeISO;
      }
      if (state.pending_swing_low != null && bar.close > state.pending_swing_low) {
        state.last_confirmed_swing_low      = state.pending_swing_low;
        state.last_confirmed_swing_low_time = state.pending_swing_low_time;
        state.pending_swing_low      = null;
        state.pending_swing_low_time = null;
      }
      state.run_candle_count = (state.run_candle_count ?? 0) + 1;
    }

    mssResult = detectMSS(bar, state);
    if (mssResult) {
      state.run_dir           = mssResult.direction;
      state.pending_swing_high = null; state.pending_swing_high_time = null;
      state.pending_swing_low  = null; state.pending_swing_low_time  = null;
      state.run_candle_count  = 1;
      state.run_start_time    = barTimeISO;
    }
  }

  state.updated_at = nowISO;
  await db.prepare(`
    INSERT INTO ${table} (symbol, tf, run_dir, run_start_time, run_candle_count,
      last_confirmed_swing_high, last_confirmed_swing_high_time,
      last_confirmed_swing_low, last_confirmed_swing_low_time,
      pending_swing_high, pending_swing_high_time,
      pending_swing_low, pending_swing_low_time, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol, tf) DO UPDATE SET
      run_dir=excluded.run_dir, run_start_time=excluded.run_start_time,
      run_candle_count=excluded.run_candle_count,
      last_confirmed_swing_high=excluded.last_confirmed_swing_high,
      last_confirmed_swing_high_time=excluded.last_confirmed_swing_high_time,
      last_confirmed_swing_low=excluded.last_confirmed_swing_low,
      last_confirmed_swing_low_time=excluded.last_confirmed_swing_low_time,
      pending_swing_high=excluded.pending_swing_high,
      pending_swing_high_time=excluded.pending_swing_high_time,
      pending_swing_low=excluded.pending_swing_low,
      pending_swing_low_time=excluded.pending_swing_low_time,
      updated_at=excluded.updated_at
  `).bind(
    symbol, tf, state.run_dir, state.run_start_time, state.run_candle_count,
    state.last_confirmed_swing_high, state.last_confirmed_swing_high_time,
    state.last_confirmed_swing_low, state.last_confirmed_swing_low_time,
    state.pending_swing_high, state.pending_swing_high_time,
    state.pending_swing_low, state.pending_swing_low_time,
    state.updated_at
  ).run();

  return mssResult;
}

function formatMSSAlert(symbol, tf, mss, htfBias, htfLabelStr) {
  const emoji      = mss.direction === 'bullish' ? '🟢' : '🔴';
  const label      = mss.direction === 'bullish' ? 'BULLISH MSS' : 'BEARISH MSS';
  const swingLabel = mss.direction === 'bullish' ? 'Swing high reclaimed' : 'Swing low reclaimed';
  const aligned    = mss.direction === htfBias || htfBias === 'neutral';
  return `${emoji} <b>${label} — ${symbol}</b>
⏱ Timeframe: ${tf}
🕐 Candle: ${fmtNY(mss.candle_time)} NY
📊 Trend: ${htfBias} (${htfLabelStr}) ${aligned ? '✅' : '⚠️'}
━━━━━━━━━━━━━━
${swingLabel}: ${mss.level?.toFixed(5)}
━━━━━━━━━━━━━━
<i>EBP Tracker</i>`;
}

// ── EBP Signal IDs (M15/1H/4H/1D — not W, separate counters from T3/NSE) ──
async function generateEbpSignalId(tf, symbol, env) {
  const counterKey = `EBP-${tf}`; // EBP-4H, EBP-1D, EBP-1W
  const row = await env.DB.prepare(
    'SELECT series, count FROM signal_counters WHERE template = ?'
  ).bind(counterKey).first();

  let { series, count } = row;
  count += 1;
  if (count > 999) {
    series = String.fromCharCode(series.charCodeAt(0) + 1);
    count = 1;
  }

  await env.DB.prepare(
    'UPDATE signal_counters SET series = ?, count = ? WHERE template = ?'
  ).bind(series, count, counterKey).run();

  const normSymbol = symbol.replace('/', '').toUpperCase();
  const countStr   = count.toString().padStart(3, '0');
  return `EBP-${normSymbol}-${tf}${series}${countStr}`;
}

// T3 Signal IDs, ported verbatim from sweep-cron.js's generator so both
// workers share the same global 'T3' signal_counters row (one counter
// across all symbols, not per-symbol). Called at chain initiation (Step 1);
// the ID is carried through Steps 2/3 via chain_state.step1_signal_id
// rather than regenerated.
async function generateSignalId(db, template, symbol) {
  const row = await db.prepare(
    'SELECT series, count FROM signal_counters WHERE template = ?'
  ).bind(template).first();

  let { series, count } = row;
  count += 1;
  if (count > 999) {
    series = String.fromCharCode(series.charCodeAt(0) + 1);
    count = 1;
  }

  await db.prepare(
    'UPDATE signal_counters SET series = ?, count = ? WHERE template = ?'
  ).bind(series, count, template).run();

  const normSymbol = symbol.replace('/', '').toUpperCase();
  const countStr   = count.toString().padStart(3, '0');
  return `${template}-${normSymbol}-${series}${countStr}`;
}

// EBP 4H/1D signals expire end of the current UTC month; 1W signals expire
// end of the current UTC quarter — these are swept by the daily cleanup in
// handleEBPCron (tf === 'D') once past expiry.
function getEbpExpiresAt(tf) {
  const now = new Date();
  if (tf === '1W') {
    const month           = now.getUTCMonth();
    const quarterEndMonth = Math.floor(month / 3) * 3 + 3;
    return new Date(Date.UTC(
      now.getUTCFullYear() + (quarterEndMonth === 12 ? 1 : 0),
      quarterEndMonth === 12 ? 0 : quarterEndMonth,
      1
    )).toISOString();
  }
  // 4H and 1D — end of current month
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    1
  )).toISOString();
}

// ============================================================
// Cron Handler — invoked via POST /cron/ebp (cron-job.org), tf is
// explicit (each cron-job.org job fires a fixed tf on its own schedule,
// mirroring the old native cron expressions this replaces).
// ============================================================
async function handleEBPCron(tf, env, debugLog = null) {
  const log = (msg) => { console.log(msg); if (debugLog) debugLog.push(msg); };

  // Daily EBP signal cleanup — sweep expired 4H/1D/1W signals once per day
  if (tf === 'D') {
    await env.DB.prepare(`
      DELETE FROM signals
      WHERE template_type = 'EBP'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
    `).bind(new Date().toISOString()).run();
  }
  log(`EBP trigger → TF: ${tf}`);

  const { results: filtered } = await env.DB.prepare(`
    SELECT ec.id as config_id, ec.alert_mode, ec.htf_override,
           ua.id as asset_id, ua.symbol, ua.bias_overrides,
           u.id as user_id, u.user_tf_access
    FROM user_ebp_configs ec
    JOIN user_assets ua ON ec.asset_id = ua.id
    JOIN users u ON ec.user_id = u.id
    WHERE ec.timeframe=? AND ec.enabled=1
    AND u.active=1
    AND ua.asset_type != 'nse'
  `).bind(tf).all();
  if (!filtered?.length) {
    log(`No enabled EBP configs for TF ${tf}`);
    return { symbolsProcessed: 0 };
  }

  const symbolMap = new Map();
  for (const row of filtered) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, []);
    symbolMap.get(row.symbol).push(row);
  }

  log(`Processing ${symbolMap.size} symbol(s) on ${tf}`);

  const defaultBiasTF = BIAS_SOURCE.ebp[tf] ?? null;

  for (const [symbol, userRows] of symbolMap) {
    try {
      let candles;
      if (tf === 'D') {
        candles = await getDailyCandlesFromCache(symbol, env);
        if (!candles || candles.length < 2) {
          log(`[${symbol}] SKIP: insufficient daily candles in cache`);
          continue;
        }
      } else if (tf === 'W') {
        candles = await getWeeklyCandlesFromCache(symbol, env);
        if (!candles || candles.length < 2) {
          log(`[${symbol}] SKIP: insufficient weekly candles in cache`);
          continue;
        }
      } else {
        candles = await getCandlesFromCache(symbol, tf, env);
        if (!candles || candles.length < 2) {
          log(`[${symbol}] SKIP: insufficient candles in cache`);
          continue;
        }
      }

      // Different users on this symbol+tf may have different htf_override
      // values, so bias must be computed per distinct HTF actually in use,
      // not once per symbol. resolveHTF() falls back to the BIAS_SOURCE
      // default when a row has no override, so this set always includes it.
      const neededHtfs = new Set(userRows.map(row => resolveHTF('ebp', tf, row.htf_override)).filter(Boolean));
      const biasByTF = new Map();
      for (const htf of neededHtfs) {
        let htfCandles;
        if (htf === 'D') {
          htfCandles = await getDailyCandlesFromCache(symbol, env);
        } else if (htf === 'W') {
          htfCandles = await getWeeklyCandlesFromCache(symbol, env);
        } else {
          htfCandles = await getCandlesFromCache(symbol, htf, env);
        }
        let bias = 'neutral';
        if (htfCandles?.length >= 2) {
          const biasResult = calcTTradesBias({ bar1: htfCandles[0], bar2: htfCandles[1] });
          biasResult.bar1Time = htfCandles[0].time;
          bias = biasResult.bias;
          await writeBiasCache(env.DB, symbol, htf, biasResult);
        }
        biasByTF.set(htf, bias);
      }
      // Symbol-level (not per-user) bias, used only for the signals table
      // record below — that table has no per-user concept.
      const htfBias = defaultBiasTF ? (biasByTF.get(defaultBiasTF) ?? 'neutral') : 'neutral';

      // Candles are newest-first; processFVGZones needs oldest-first.
      // Daily TF only has the two synthesised bars (bar0/bar1) — FVG needs 3,
      // so it's skipped there, but swing state / MSS still run on bar0.
      let mssResult = null;
      if (tf === 'D') {
        mssResult = await updateSwingState(env.DB, 'swing_states', symbol, tf, [null, null, candles[0]]);
      } else if (candles.length >= 3) {
        const oldestFirst = [candles[2], candles[1], candles[0]];
        await processFVGZones(env.DB, 'fvg_zones', symbol, tf, oldestFirst, candles[0]);

        mssResult = await updateSwingState(env.DB, 'swing_states', symbol, tf, oldestFirst);
      }
      if (mssResult) {
        for (const row of userRows) {
          const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
          if (!userTfAccess.includes(tf)) continue;

          const userBiasTF    = resolveHTF('ebp', tf, row.htf_override);
          const userHtfBias   = userBiasTF ? (biasByTF.get(userBiasTF) ?? 'neutral') : 'neutral';
          const alertMode     = row.alert_mode ?? 'aligned';
          const biasOverrides = JSON.parse(row.bias_overrides || '{}');
          const effectiveBias = getEffectiveBias(userBiasTF, { [userBiasTF]: { bias: userHtfBias } }, biasOverrides);
          const shouldAlert   = alertMode === 'all' || mssResult.direction === effectiveBias || effectiveBias === 'neutral';
          if (!shouldAlert) continue;

          const tg = await env.DB.prepare(
            'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
          ).bind(row.user_id).first();
          if (!tg?.chat_id) continue;

          const isDup = await isDuplicateAlert(env.DB, row.user_id, symbol, tf, mssResult.direction, 'mss');
          if (isDup) {
            console.log(`[${symbol}] DEDUP: skipping duplicate ${tf} ${mssResult.direction} MSS alert`);
            continue;
          }

          const msg = formatMSSAlert(symbol, tf, mssResult, userHtfBias, getHTFBiasLabel(userBiasTF));
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);

          await env.DB.prepare(
            `INSERT INTO alert_history
             (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
             VALUES (?,?,?,?,?,?,?,?,'mss')`
          ).bind(
            crypto.randomUUID(), row.user_id, symbol, tf,
            mssResult.direction, userHtfBias, mssResult.candle_time, new Date().toISOString()
          ).run();
        }
      }

      const ebp = detectEBP(candles);
      if (!ebp) {
        log(`[${symbol}] no EBP detected`);
        continue;
      }

      // Signal ID generated once per symbol+TF event here (not per user
      // below) — every user notified for this event shares the same ID.
      let ebpSignalId = null;
      if (tf !== 'W') {
        const signalTf = tf === 'D' ? '1D' : tf; // 'D'→'1D'; M15/1H/4H pass through unchanged
        ebpSignalId = await generateEbpSignalId(signalTf, symbol, env);
        const firedAt = new Date().toISOString();
        // price_at_signal: detectEBP() has no `ebpCandle` — the EBP candle's
        // close is ebp.closedLevel (= bar0.close), already computed above.
        await env.DB.prepare(`
          INSERT INTO signals (
            signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at, expires_at,
            price_at_signal, htf_bias, session, htf_close
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          ebpSignalId, 'EBP', symbol, null, signalTf,
          ebp.direction, firedAt, getEbpExpiresAt(signalTf),
          ebp.closedLevel ?? null,
          htfBias ?? null,
          deriveSession(firedAt),
          null
        ).run();
      }

      for (const row of userRows) {
        const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
        if (!userTfAccess.includes(tf)) continue;

        const userBiasTF    = resolveHTF('ebp', tf, row.htf_override);
        const userHtfBias   = userBiasTF ? (biasByTF.get(userBiasTF) ?? 'neutral') : 'neutral';
        const alertMode     = row.alert_mode ?? 'aligned';
        const biasOverrides = JSON.parse(row.bias_overrides || '{}');
        const effectiveBias = getEffectiveBias(userBiasTF, { [userBiasTF]: { bias: userHtfBias } }, biasOverrides);
        const trendAligned  = ebp.direction === effectiveBias;

        // tg is needed by both the plain EBP alert below and the T1/T2
        // template loop (T2's S1 message) — fetched once, unconditionally,
        // so a template with bias_gate=0 can still fire even on a cron cycle
        // where the plain EBP alert itself is skipped for misalignment.
        const tg = await env.DB.prepare(
          'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
        ).bind(row.user_id).first();
        if (!tg?.chat_id) continue;

        // Captures whether the plain EBP alert actually reached this user's
        // Telegram this cycle — T2's S1 alert (below) fires only when this
        // is false, so T2 doesn't send a redundant notification for the
        // same EBP event the user already got via the plain alert. Checking
        // user_ebp_configs.enabled here would be tautological: handleEBPCron(tf)
        // itself only ever processes users who already have that config
        // enabled for this exact tf (see the function's own driving query).
        let ebpAlertSentThisCycle = false;

        if (!(alertMode === 'aligned' && !trendAligned)) {
          const isDup = await isDuplicateAlert(env.DB, row.user_id, symbol, tf, ebp.direction, 'ebp');
          if (isDup) {
            console.log(`[${symbol}] DEDUP: skipping duplicate ${tf} ${ebp.direction} EBP alert`);
          } else {
            const msg = formatEBPAlert({
              symbol, tf,
              direction:   ebp.direction,
              candleTime:  ebp.candleTime,
              trendBias:   effectiveBias,
              trendAligned,
              sweptLevel:  ebp.sweptLevel?.toFixed(5),
              closedLevel: ebp.closedLevel?.toFixed(5),
              signalId:    ebpSignalId,
              biasTF:      userBiasTF,
            });

            await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);
            ebpAlertSentThisCycle = true;

            await env.DB.prepare(`
              INSERT INTO alert_history
              (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
              VALUES (?,?,?,?,?,?,?,?,'ebp')
            `).bind(
              crypto.randomUUID(), row.user_id, symbol, tf,
              ebp.direction, effectiveBias, ebp.candleTime, new Date().toISOString()
            ).run();
          }
        }

        // T1/T2 Step 1, both triggered by this same EBP event. Runs
        // independently of the plain EBP alert's alignment gate above —
        // each template's own bias_gate column decides whether ITS chain
        // requires HTF-bias alignment (default: yes).
        for (const templateId of ['t1', 't2']) {
          const tmpl = await env.DB.prepare(
            `SELECT * FROM user_templates WHERE user_id=? AND asset_id=? AND template=? AND enabled=1 AND htf=?`
          ).bind(row.user_id, row.asset_id, templateId, tf).first();
          if (!tmpl) continue;

          const biasGateEnabled = tmpl.bias_gate !== 0; // default 1 = enabled
          if (biasGateEnabled && !trendAligned) continue;

          if (templateId === 't1') {
            // T1: 4H EBP → FVG in OTE zone → body close beyond FVG (CISD proxy)
            // Arms silently. Single alert fires at CISD confirmation only.
            const htfIntervalMsT1 = TF_INTERVAL_MS[tf] ?? 0;
            const t1Candle = candles[0]; // most recent closed candle = the EBP candle
            const t1High = t1Candle.high;
            const t1Low = t1Candle.low;
            const t1Range = t1High - t1Low;

            // OTE zone: 0.5–0.768 retracement of EBP candle high to low (bullish)
            // Bearish mirror: premium zone above 0.5
            let t1OteTop, t1OteBottom;
            if (ebp.direction === 'bullish') {
              t1OteTop    = t1High - t1Range * 0.5;    // 50% level
              t1OteBottom = t1High - t1Range * 0.768;  // 76.8% level
            } else {
              t1OteBottom = t1Low + t1Range * 0.5;
              t1OteTop    = t1Low + t1Range * 0.768;
            }

            await insertChain(env.DB, {
              templateType: 'T1',
              userId: row.user_id,
              assetId: row.asset_id,
              symbol,
              htf: tf,
              ltf: tmpl.ltf,
              direction: ebp.direction,
              state: 'awaiting_cisd',
              expiresAt: endOfUTCWeekISO(),
              htfHigh: t1High,
              htfLow: t1Low,
              htfCandleOpenTime: new Date(t1Candle.time).toISOString(),
              htfCandleCloseTime: new Date(t1Candle.time + htfIntervalMsT1).toISOString(),
              oteTop: t1OteTop,
              oteBottom: t1OteBottom,
              zoneType: 'ote',
            });
          } else if (templateId === 't2') {
            // T2: 4H EBP → zone entry → optional sweep → CISD or MSS.
            // Signal ID born at S1 (EBP fire). S1 alert sent only if the
            // plain EBP alert did NOT reach this user this cycle
            // (ebpAlertSentThisCycle, captured above). Arms with
            // state='awaiting_zone_entry'.
            const htfIntervalMsT2 = TF_INTERVAL_MS[tf] ?? 0;
            const t2Candle = candles[0];
            const t2High = t2Candle.high;
            const t2Low = t2Candle.low;
            const t2Range = t2High - t2Low;

            // Toggles from the user_templates row (migration 016 columns).
            const oteEnabled    = tmpl.ote_enabled    ?? 1;
            const sweepRequired = tmpl.sweep_required ?? 0;
            const triggerType   = tmpl.trigger_type   ?? 'cisd';

            // Compute zone boundaries
            let t2ZoneTop, t2ZoneBottom, t2ZoneType;
            if (oteEnabled) {
              // OTE zone: 0.5–0.768 retracement
              if (ebp.direction === 'bullish') {
                t2ZoneTop    = t2High - t2Range * 0.5;
                t2ZoneBottom = t2High - t2Range * 0.768;
              } else {
                t2ZoneBottom = t2Low + t2Range * 0.5;
                t2ZoneTop    = t2Low + t2Range * 0.768;
              }
              t2ZoneType = 'ote';
            } else {
              // Discount (bull) / Premium (bear) — below/above 0.5
              if (ebp.direction === 'bullish') {
                t2ZoneTop    = t2High - t2Range * 0.5;
                t2ZoneBottom = t2Low;
                t2ZoneType   = 'discount';
              } else {
                t2ZoneBottom = t2Low + t2Range * 0.5;
                t2ZoneTop    = t2High;
                t2ZoneType   = 'premium';
              }
            }

            // Generate signal ID at S1
            const t2SignalId = await generateSignalId(env.DB, 'T2', symbol);

            // S1 fires only if the plain EBP alert didn't already notify
            // this user this cycle.
            const sendS1 = !ebpAlertSentThisCycle;

            await insertChain(env.DB, {
              templateType: 'T2',
              userId: row.user_id,
              assetId: row.asset_id,
              symbol,
              htf: tf,
              ltf: tmpl.ltf,
              direction: ebp.direction,
              state: 'awaiting_zone_entry',
              expiresAt: endOfUTCWeekISO(),
              signalId: t2SignalId,
              step: 1,
              htfHigh: t2High,
              htfLow: t2Low,
              htfCandleOpenTime: new Date(t2Candle.time).toISOString(),
              htfCandleCloseTime: new Date(t2Candle.time + htfIntervalMsT2).toISOString(),
              oteTop: t2ZoneTop,
              oteBottom: t2ZoneBottom,
              zoneType: t2ZoneType,
              oteEnabled,
              sweepRequired,
              triggerType,
              s1Sent: sendS1,
            });

            // tg was already fetched, unconditionally, earlier in this
            // per-user loop — no need to re-query user_telegram here.
            if (sendS1) {
              const s1Text = formatT2S1Alert({
                symbol,
                htf: tf,
                ltf: tmpl.ltf,
                direction: ebp.direction,
                zoneTop: t2ZoneTop,
                zoneBottom: t2ZoneBottom,
                zoneType: t2ZoneType,
                triggerType,
                signalId: t2SignalId,
              });
              await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, s1Text);
            }
          }
        }
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      const msg = `Error ${symbol} ${tf}: ${err.message}`;
      console.error(msg);
      if (debugLog) debugLog.push(`[ERROR] ${msg}`);
    }
  }

  // T3: Daily candle → 50–75% zone FVG → CISD or MSS. Independent of
  // user_ebp_configs/EBP detection entirely — driven directly by
  // user_templates, same pattern T4 uses in sweep-cron.js, since T3's own
  // trigger (previous day's TTrades closure bias) has no EBP dependency.
  if (tf === 'D') {
    const { results: t3Templates } = await env.DB.prepare(`
      SELECT ut.*, ua.symbol, ua.asset_type, u.id as user_id
      FROM user_templates ut
      JOIN user_assets ua ON ut.asset_id = ua.id
      JOIN users u ON ut.user_id = u.id
      WHERE ut.template = 't3'
      AND ut.enabled = 1
      AND ut.htf = 'D'
      AND u.active = 1
      AND ua.asset_type != 'nse'
    `).all();

    const dailyCandleCache = new Map();

    for (const tmpl of t3Templates ?? []) {
      try {
        if (!dailyCandleCache.has(tmpl.symbol)) {
          dailyCandleCache.set(tmpl.symbol, await getDailyCandlesFromCache(tmpl.symbol, env));
        }
        const dailyCandles = dailyCandleCache.get(tmpl.symbol);
        if (!dailyCandles || dailyCandles.length < 2) continue;

        // Previous day candle = the daily bar that just closed
        // (dailyCandles[0], newest-first) — same bar0/bar1 convention
        // detectEBP() uses for every other timeframe.
        const prevCandle  = dailyCandles[0];
        const priorCandle = dailyCandles[1];
        const prevHigh = prevCandle.high;
        const prevLow  = prevCandle.low;

        const biasResult = calcTTradesBias({ bar1: prevCandle, bar2: priorCandle });
        const bias = biasResult.bias;
        if (bias === 'neutral') continue;

        const range = prevHigh - prevLow;
        let zoneTop, zoneBottom, target;
        if (bias === 'bullish') {
          zoneTop    = prevHigh - range * 0.50;
          zoneBottom = prevHigh - range * 0.75;
          target     = prevHigh;
        } else {
          zoneBottom = prevLow + range * 0.50;
          zoneTop    = prevLow + range * 0.75;
          target     = prevLow;
        }

        const triggerType = tmpl.trigger_type ?? 'cisd';

        // Idempotent — cheap to run unconditionally. Must run before
        // generateSignalId(), not after insertChain(): generateSignalId()
        // throws on a missing counter row (destructures null), so seeding
        // after the fact is too late for the very first T3 arm.
        await env.DB.prepare(
          `INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('T3', 'A', 0)`
        ).run();
        const t3SignalId = await generateSignalId(env.DB, 'T3', tmpl.symbol);

        await insertChain(env.DB, {
          templateType: 'T3',
          userId: tmpl.user_id,
          assetId: tmpl.asset_id,
          symbol: tmpl.symbol,
          htf: 'D',
          ltf: tmpl.ltf,
          direction: bias,
          state: 'awaiting_time_gate',
          expiresAt: endOfUTCWeekISO(),
          signalId: t3SignalId,
          step: 1,
          htfHigh: prevHigh,
          htfLow: prevLow,
          oteTop: zoneTop,
          oteBottom: zoneBottom,
          zoneType: 'fifty_seventy_five',
          triggerType,
          s1Sent: true,
        });

        const tg = await env.DB.prepare(
          'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
        ).bind(tmpl.user_id).first();
        if (tg?.chat_id) {
          const s1Text = formatT3S1Alert({
            symbol: tmpl.symbol,
            ltf: tmpl.ltf,
            direction: bias,
            zoneTop, zoneBottom,
            target,
            triggerType,
            signalId: t3SignalId,
          });
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, s1Text);
        }

        // trend_bias: T3 has no separate live bias comparison at arm
        // time (unlike T1/T2) — bias itself is both the direction and
        // the triggering condition, so the same value goes in both columns.
        await env.DB.prepare(`
          INSERT INTO alert_history
          (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
          VALUES (?,?,?,?,?,?,?,?,'t3')
        `).bind(
          crypto.randomUUID(), tmpl.user_id, tmpl.symbol, 'D',
          bias, bias, prevCandle.time, new Date().toISOString()
        ).run();

        log(`[${tmpl.symbol}] T3 chain armed (${bias})`);
      } catch (err) {
        const msg = `T3 init error ${tmpl.symbol}: ${err.message}`;
        console.error(msg);
        if (debugLog) debugLog.push(`[ERROR] ${msg}`);
      }
    }
  }

  return { symbolsProcessed: symbolMap.size };
}

let _jwksCache = null;
let _jwksCacheTime = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

// ============================================================
// Auth — Clerk JWT via Web Crypto (no npm needed)
// ============================================================
async function verifyClerkToken(token, secretKey) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');

  const payload = JSON.parse(
    atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
  );
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  // Fetch Clerk JWKS to verify signature — cached for 1 hour so this
  // doesn't hit Clerk on every single authenticated request.
  const now = Date.now();
  if (!_jwksCache || (now - _jwksCacheTime) > JWKS_TTL_MS) {
    const res = await fetch('https://api.clerk.com/v1/jwks', {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    _jwksCache = await res.json();
    _jwksCacheTime = now;
  }
  const jwks = _jwksCache;

  const header = JSON.parse(
    atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'))
  );
  const jwk = jwks.keys?.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('JWK key not found');

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );

  const enc  = new TextEncoder();
  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const sig  = Uint8Array.from(
    atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!valid) throw new Error('Invalid signature');

  return {
    id:    payload.sub,
    email: payload.email ?? payload.primary_email_address ?? '',
    name:  payload.first_name
      ? `${payload.first_name} ${payload.last_name ?? ''}`.trim()
      : '',
  };
}

async function getOrCreateUser(db, clerkUser) {
  const now     = Date.now();
  const expires = now + 30 * 24 * 60 * 60 * 1000;
  await db.prepare(`
    INSERT INTO users (id, email, name, created_at, expires_at, asset_limit, user_tf_access, nse_tf_access)
    VALUES (?,?,?,?,?,5,'["M5","M15","M30","1H","4H","D","W"]','["M1","M5","M15","M30","1H","D"]')
    ON CONFLICT(id) DO NOTHING
  `).bind(clerkUser.id, clerkUser.email, clerkUser.email.split('@')[0], now, expires).run();

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(clerkUser.id).first();
  if (user?.active && user.expires_at < now) {
    await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(clerkUser.id).run();
    user.active = 0;
  }
  return user;
}

// ============================================================
// Request Handler
// ============================================================
const router = new Router();

// Health
router.get('/health', async (req, env) => {
  return json({ status: 'ok', timestamp: new Date().toISOString() }, 200, getOrigin(req));
});

// ── User ──────────────────────────────────────────────────────

router.get('/user/me', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  await getOrCreateUser(env.DB, clerkUser);
  const user = await env.DB.prepare(
    'SELECT id, email, name, plan, asset_limit, created_at, expires_at, active, is_admin, user_tf_access, nse_tf_access FROM users WHERE id=?'
  ).bind(clerkUser.id).first();
  return json(user, 200, origin);
});

router.get('/user/assets', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const assets = await env.DB.prepare(
    'SELECT * FROM user_assets WHERE user_id = ? ORDER BY added_at ASC'
  ).bind(clerkUser.id).all();

  const enriched = await Promise.all((assets.results ?? []).map(async asset => {
    const { results: configs } = await env.DB.prepare(
      'SELECT timeframe FROM user_ebp_configs WHERE asset_id = ? AND enabled = 1'
    ).bind(asset.id).all();
    const tfs    = (configs ?? []).map(c => c.timeframe);
    const status = {};
    for (const tf of tfs) {
      let candles;
      if (tf === 'D')      candles = await getDailyCandlesFromCache(asset.symbol, env);
      else if (tf === 'W') candles = await getWeeklyCandlesFromCache(asset.symbol, env);
      else                 candles = await getCandlesFromCache(asset.symbol, tf, env);

      if (candles && candles.length >= 2) {
        const ebp = detectEBP(candles);
        status[tf] = ebp ? ebp.direction : 'none';
      } else {
        status[tf] = 'none';
      }
    }
    return { ...asset, ebpStatus: status };
  }));

  return json(enriched, 200, origin);
});

router.post('/user/assets', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const body = await req.json();
  const user = await getOrCreateUser(env.DB, clerkUser);

  const assetType = body.assetType ?? 'forex';

  // Slot limit applies to forex/crypto only — NSE assets are unlimited and
  // never count against asset_limit.
  if (assetType !== 'nse' && assetType !== 'system') {
    const count = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND asset_type != 'nse' AND asset_type != 'system'"
    ).bind(clerkUser.id).first();
    if (count.cnt >= user.asset_limit) {
      return json({ error: 'asset_limit_reached', limit: user.asset_limit }, 403, origin);
    }
  }

  const symbolStr = normaliseSymbol(String(body.symbol ?? '').toUpperCase().trim());
  if (!symbolStr) {
    return json({ error: 'Symbol is required.' }, 400, origin);
  }
  const existing = await env.DB.prepare(
    'SELECT id FROM user_assets WHERE user_id = ? AND symbol = ?'
  ).bind(clerkUser.id, symbolStr).first();
  if (existing) {
    return json({ error: 'Asset already in your list.' }, 400, origin);
  }

  if (assetType !== 'forex' && assetType !== 'crypto' && assetType !== 'system') {
    // NSE ('nse') and any unrecognised type still go through Yahoo validation.
    // Forex/crypto come from the hardcoded asset browser list, and 'system'
    // symbols (e.g. DXY) are known-valid — all skip this call.
    const validation = await validateSymbol(symbolStr);
    if (!validation.valid) {
      return json({ error: 'Symbol not found on any data source.' }, 400, origin);
    }
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO user_assets (id, user_id, symbol, display_name, asset_type, added_at)
    VALUES (?,?,?,?,?,?)
  `).bind(id, clerkUser.id, symbolStr,
    body.displayName ?? symbolStr,
    assetType, Date.now()).run();

  return json({ id, symbol: symbolStr }, 201, origin);
});

router.get('/user/assets/count', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const forexRow = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND asset_type != 'nse' AND asset_type != 'system'"
  ).bind(clerkUser.id).first();
  const nseRow = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND asset_type = 'nse'"
  ).bind(clerkUser.id).first();
  const userRow = await env.DB.prepare(
    'SELECT asset_limit FROM users WHERE id = ?'
  ).bind(clerkUser.id).first();

  const forexCryptoCount = forexRow?.cnt ?? 0;
  const nseCount         = nseRow?.cnt ?? 0;
  const limit            = userRow?.asset_limit ?? 5;

  return json({
    forex_crypto_count:     forexCryptoCount,
    forex_crypto_limit:     limit,
    forex_crypto_remaining: Math.max(0, limit - forexCryptoCount),
    nse_count:              nseCount,
    nse_limit:              'unlimited',
  }, 200, origin);
});

router.delete('/user/assets/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  await env.DB.prepare('DELETE FROM user_ebp_configs WHERE asset_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM user_sweep_configs WHERE asset_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM user_templates WHERE asset_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM chain_state WHERE asset_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM nse_indicator_configs WHERE asset_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM nse_indicator_chain WHERE asset_id = ?').bind(params.id).run();
  await env.DB.prepare(
    'DELETE FROM user_assets WHERE id = ? AND user_id = ?'
  ).bind(params.id, clerkUser.id).run();

  return json({ success: true }, 200, origin);
});

router.patch('/user/assets/:id/bias-overrides', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { bias_overrides } = await req.json();
  await env.DB.prepare(
    'UPDATE user_assets SET bias_overrides = ? WHERE id = ? AND user_id = ?'
  ).bind(JSON.stringify(bias_overrides ?? {}), params.id, clerkUser.id).run();
  return json({ ok: true }, 200, origin);
});

router.get('/user/assets/validate', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const url       = new URL(req.url);
  const rawSymbol = url.searchParams.get('symbol');
  if (!rawSymbol) return json({ valid: false, error: 'Symbol is required' }, 400, origin);

  const symbol = normaliseSymbol(rawSymbol.trim().toUpperCase());

  // Twelve Data's symbol_search has no exact entry for bare index names like
  // NIFTY/SENSEX/DJI — it falls back to an unrelated ETF or namesake stock
  // (e.g. "SPX" matches a Common Stock ticker, not the S&P 500 index).
  // Short-circuit these before ever hitting the API.
  if (['NIFTY', 'SENSEX', 'SPX', 'DJI', 'NDX'].includes(symbol)) {
    return json({ valid: true, symbol, asset_type: 'index' }, 200, origin);
  }

  // Twelve Data symbol_search removed — EBP Worker no longer calls Twelve
  // Data directly for anything (Watchdog Worker is the sole caller now).
  // This route has no frontend caller today; the guess-based fallback below
  // (previously used only when all keys were exhausted) is now the only path.
  return json({ valid: true, symbol, asset_type: guessAssetType(symbol), source: 'fallback' }, 200, origin);
});

// ── EBP Configs ───────────────────────────────────────────────

router.get('/user/ebp-configs/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM user_ebp_configs WHERE asset_id=? AND user_id=? ORDER BY created_at ASC'
  ).bind(params.assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
});

router.post('/user/ebp-configs/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { timeframe, alert_mode } = await req.json();
  if (!timeframe) return json({ error: 'timeframe required' }, 400, origin);

  const asset = await env.DB.prepare('SELECT asset_type FROM user_assets WHERE id = ?').bind(params.assetId).first();

  let tfAccess;
  if (asset?.asset_type === 'nse') {
    const userRow = await env.DB.prepare('SELECT nse_tf_access FROM users WHERE id = ?').bind(clerkUser.id).first();
    tfAccess = JSON.parse(userRow?.nse_tf_access || '["M1","M5","M15","M30","1H","D"]');
  } else {
    const userRow = await env.DB.prepare('SELECT user_tf_access FROM users WHERE id = ?').bind(clerkUser.id).first();
    tfAccess = JSON.parse(userRow?.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
  }
  if (!tfAccess.includes(timeframe)) {
    return json({ error: 'tf_access_denied', message: 'This timeframe is not enabled for your account' }, 403, origin);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO user_ebp_configs (id,user_id,asset_id,timeframe,alert_mode,enabled,created_at) VALUES (?,?,?,?,?,1,?)'
  ).bind(id, clerkUser.id, params.assetId, timeframe, alert_mode ?? 'aligned', Date.now()).run();
  return json({ id, timeframe, alert_mode: alert_mode ?? 'aligned', enabled: 1 }, 201, origin);
});

// ── Sweep Configs ─────────────────────────────────────────────

router.get('/user/sweep-configs/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM user_sweep_configs WHERE asset_id=? AND user_id=? ORDER BY created_at ASC'
  ).bind(params.assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
});

router.post('/user/sweep-configs/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { timeframe, alert_mode } = await req.json();
  if (!timeframe) return json({ error: 'timeframe required' }, 400, origin);

  const asset = await env.DB.prepare('SELECT asset_type FROM user_assets WHERE id = ?').bind(params.assetId).first();

  let tfAccess;
  if (asset?.asset_type === 'nse') {
    const userRow = await env.DB.prepare('SELECT nse_tf_access FROM users WHERE id = ?').bind(clerkUser.id).first();
    tfAccess = JSON.parse(userRow?.nse_tf_access || '["M1","M5","M15","M30","1H","D"]');
  } else {
    const userRow = await env.DB.prepare('SELECT user_tf_access FROM users WHERE id = ?').bind(clerkUser.id).first();
    tfAccess = JSON.parse(userRow?.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
  }
  if (!tfAccess.includes(timeframe)) {
    return json({ error: 'tf_access_denied', message: 'This timeframe is not enabled for your account' }, 403, origin);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO user_sweep_configs (id,user_id,asset_id,timeframe,alert_mode,enabled,created_at) VALUES (?,?,?,?,?,1,?)'
  ).bind(id, clerkUser.id, params.assetId, timeframe, alert_mode ?? 'aligned', Date.now()).run();
  return json({ id, timeframe, alert_mode: alert_mode ?? 'aligned', enabled: 1 }, 201, origin);
});

// ── Templates (CRUD) ──────────────────────────────────────────

router.get('/user/templates/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM user_templates WHERE asset_id=? AND user_id=? ORDER BY created_at ASC'
  ).bind(params.assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
});

router.post('/user/templates/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { template, htf, ltf, window_mins, enabled } = await req.json();
  if (!template || !htf || !ltf) return json({ error: 'template, htf, ltf required' }, 400, origin);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO user_templates (id,user_id,asset_id,template,enabled,htf,ltf,window_mins,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(id, clerkUser.id, params.assetId, template, enabled ? 1 : 0, htf, ltf, window_mins ?? 60, Date.now()).run();
  return json({ id, template, htf, ltf, window_mins: window_mins ?? 60, enabled: enabled ? 1 : 0 }, 201, origin);
});

const TEMPLATE_TF_RANK = { 'M5': 1, 'M15': 2, 'M30': 3, '1H': 4, '4H': 5, 'D': 6, 'W': 7 };

router.patch('/user/template/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { enabled, htf, ltf, window_mins, bias_gate, fvg_rule, step3_enabled } = await req.json();
  if (htf && ltf && TEMPLATE_TF_RANK[ltf] >= TEMPLATE_TF_RANK[htf]) {
    return json({ error: 'LTF must be strictly lower than HTF' }, 400, origin);
  }
  if (fvg_rule !== undefined && !['50_percent', 'any_touch', 'full_fill'].includes(fvg_rule)) {
    return json({ error: "fvg_rule must be '50_percent', 'any_touch', or 'full_fill'" }, 400, origin);
  }
  if (window_mins !== undefined && (window_mins < 15 || window_mins > 240)) {
    return json({ error: 'window_mins must be between 15 and 240' }, 400, origin);
  }
  await env.DB.prepare(
    'UPDATE user_templates SET enabled=COALESCE(?,enabled), htf=COALESCE(?,htf), ltf=COALESCE(?,ltf), window_mins=COALESCE(?,window_mins), bias_gate=COALESCE(?,bias_gate), fvg_rule=COALESCE(?,fvg_rule), step3_enabled=COALESCE(?,step3_enabled) WHERE id=? AND user_id=?'
  ).bind(
    enabled ?? null, htf ?? null, ltf ?? null, window_mins ?? null,
    bias_gate ?? null, fvg_rule ?? null, step3_enabled ?? null,
    params.id, clerkUser.id
  ).run();
  return json({ ok: true }, 200, origin);
});

router.delete('/user/template/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  await env.DB.prepare(
    'DELETE FROM user_templates WHERE id=? AND user_id=?'
  ).bind(params.id, clerkUser.id).run();
  return json({ ok: true }, 200, origin);
});

// ── Chain State ──────────────────────────────
// Active T1/T2/T3/T4 chain progress for a given asset, for display only —
// no mutation route; chains are written exclusively by the cron workers.

router.get('/user/chain-state/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const asset = await env.DB.prepare(
    'SELECT id FROM user_assets WHERE id = ? AND user_id = ?'
  ).bind(params.assetId, clerkUser.id).first();
  if (!asset) return json({ error: 'Asset not found' }, 404, origin);

  const { results } = await env.DB.prepare(`
    SELECT id, template_type, direction, state, htf, ltf,
           step1_signal_id, step2_signal_id, step3_signal_id,
           fvg_id, created_at, expires_at
    FROM chain_state
    WHERE user_id = ? AND asset_id = ?
      AND state != 'complete'
      AND expires_at > ?
    ORDER BY created_at DESC
  `).bind(clerkUser.id, params.assetId, new Date().toISOString()).all();

  return json(results ?? [], 200, origin);
});

// ── FVG Zones ─────────────────────────────────
// Active + recently-mitigated fvg_zones for the asset's own configured
// EBP/Sweep signal TFs only — not every TF that happens to have a zone.

router.get('/user/fvg-zones/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const { results: configTfRows } = await env.DB.prepare(`
    SELECT DISTINCT timeframe FROM user_ebp_configs WHERE asset_id = ? AND user_id = ?
    UNION
    SELECT DISTINCT timeframe FROM user_sweep_configs WHERE asset_id = ? AND user_id = ?
  `).bind(params.assetId, clerkUser.id, params.assetId, clerkUser.id).all();

  const tfs = (configTfRows ?? []).map(r => r.timeframe);
  if (tfs.length === 0) return json([], 200, origin);

  const asset = await env.DB.prepare(
    'SELECT symbol FROM user_assets WHERE id = ? AND user_id = ?'
  ).bind(params.assetId, clerkUser.id).first();
  if (!asset) return json([], 200, origin);

  const placeholders = tfs.map(() => '?').join(',');
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  const { results: zones } = await env.DB.prepare(`
    SELECT id, tf, direction, top, bottom, midpoint,
           formed_at, expires_at, mitigated_at, mitigated_by_tf
    FROM fvg_zones
    WHERE symbol = ?
      AND tf IN (${placeholders})
      AND expires_at > ?
      AND (mitigated_at IS NULL OR mitigated_at > ?)
    ORDER BY
      CASE WHEN mitigated_at IS NULL THEN 0 ELSE 1 END ASC,
      formed_at DESC
  `).bind(asset.symbol, ...tfs, nowIso, cutoff24h).all();

  return json(zones ?? [], 200, origin);
});

// ── Dashboard ─────────────────────────────────────────────────

router.get('/dashboard', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const assets = await env.DB.prepare(`
    SELECT ua.*,
      (SELECT fired_at FROM alert_history
       WHERE user_id = ua.user_id AND symbol = ua.symbol
       ORDER BY fired_at DESC LIMIT 1) as last_alert_at
    FROM user_assets ua
    WHERE ua.user_id = ?
    ORDER BY ua.added_at ASC
  `).bind(clerkUser.id).all();
  return json(assets.results ?? [], 200, origin);
});

router.patch('/user/ebp-configs/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const body = await req.json();

  let effectiveTf = body.timeframe;
  if (effectiveTf === undefined && body.htf_override !== undefined) {
    const existing = await env.DB.prepare(
      'SELECT timeframe FROM user_ebp_configs WHERE id = ? AND user_id = ?'
    ).bind(params.id, clerkUser.id).first();
    effectiveTf = existing?.timeframe;
  }

  const sets = []; const vals = [];
  if (body.timeframe !== undefined) {
    sets.push('timeframe = ?'); vals.push(body.timeframe);
    // TF change resets htf_override to null (falls back to BIAS_SOURCE
    // default) unless this same request also sets a new override.
    if (body.htf_override === undefined) { sets.push('htf_override = ?'); vals.push(null); }
  }
  if (body.alert_mode !== undefined) { sets.push('alert_mode = ?'); vals.push(body.alert_mode); }
  if (body.enabled !== undefined)    { sets.push('enabled = ?');    vals.push(body.enabled ? 1 : 0); }
  if (body.htf_override !== undefined) {
    if (body.htf_override === null) {
      sets.push('htf_override = ?'); vals.push(null);
    } else {
      const allowed = VALID_HTF_OVERRIDES[effectiveTf];
      if (!allowed || !allowed.includes(body.htf_override)) {
        return json({ error: `htf_override not valid for timeframe ${effectiveTf}` }, 400, origin);
      }
      sets.push('htf_override = ?'); vals.push(body.htf_override);
    }
  }
  if (!sets.length) return json({ ok: true }, 200, origin);
  vals.push(clerkUser.id, params.id);
  await env.DB.prepare(`UPDATE user_ebp_configs SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).bind(...vals).run();
  return json({ ok: true }, 200, origin);
});

router.delete('/user/ebp-configs/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  await env.DB.prepare('DELETE FROM user_ebp_configs WHERE user_id = ? AND id = ?').bind(clerkUser.id, params.id).run();
  return json({ ok: true }, 200, origin);
});

router.patch('/user/sweep-configs/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const body = await req.json();

  let effectiveTf = body.timeframe;
  if (effectiveTf === undefined && body.htf_override !== undefined) {
    const existing = await env.DB.prepare(
      'SELECT timeframe FROM user_sweep_configs WHERE id = ? AND user_id = ?'
    ).bind(params.id, clerkUser.id).first();
    effectiveTf = existing?.timeframe;
  }

  const sets = []; const vals = [];
  if (body.timeframe !== undefined) {
    sets.push('timeframe = ?'); vals.push(body.timeframe);
    // TF change resets htf_override to null (falls back to BIAS_SOURCE
    // default) unless this same request also sets a new override.
    if (body.htf_override === undefined) { sets.push('htf_override = ?'); vals.push(null); }
  }
  if (body.alert_mode !== undefined) { sets.push('alert_mode = ?'); vals.push(body.alert_mode); }
  if (body.enabled !== undefined)    { sets.push('enabled = ?');    vals.push(body.enabled ? 1 : 0); }
  if (body.htf_override !== undefined) {
    if (body.htf_override === null) {
      sets.push('htf_override = ?'); vals.push(null);
    } else {
      const allowed = VALID_HTF_OVERRIDES[effectiveTf];
      if (!allowed || !allowed.includes(body.htf_override)) {
        return json({ error: `htf_override not valid for timeframe ${effectiveTf}` }, 400, origin);
      }
      sets.push('htf_override = ?'); vals.push(body.htf_override);
    }
  }
  if (!sets.length) return json({ ok: true }, 200, origin);
  vals.push(clerkUser.id, params.id);
  await env.DB.prepare(`UPDATE user_sweep_configs SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).bind(...vals).run();
  return json({ ok: true }, 200, origin);
});

router.delete('/user/sweep-configs/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  await env.DB.prepare('DELETE FROM user_sweep_configs WHERE user_id = ? AND id = ?').bind(clerkUser.id, params.id).run();
  return json({ ok: true }, 200, origin);
});

// ── Forex/Crypto SMA Cloud Configs (2026-08-05) ─────────────────
// Cron logic lives in Sweep Worker (handleForexSmaCron) — this worker only
// owns the CRUD routes, same split as EBP Worker owning NSE indicator
// config routes while nse-worker owns the NSE cron logic.

const FOREX_SMA_TFS = ['M15', 'M30', '1H', '4H'];
const FOREX_SMA_HTF_OPTIONS = {
  'M15': ['4H'],
  'M30': ['4H'],
  '1H':  ['4H', 'D'],
  '4H':  ['D'],
};

router.get('/user/forex-indicator-configs/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM forex_indicator_configs WHERE asset_id=? AND user_id=? ORDER BY created_at ASC'
  ).bind(params.assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
});

router.post('/user/forex-indicator-configs/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { timeframe, bias_mode, htf_timeframe, confirmation_mode } = await req.json();

  if (!FOREX_SMA_TFS.includes(timeframe)) {
    return json({ error: `timeframe must be one of: ${FOREX_SMA_TFS.join(', ')}` }, 400, origin);
  }
  if (bias_mode !== undefined && !['ttrades', 'htf_sma', 'none'].includes(bias_mode)) {
    return json({ error: "bias_mode must be 'ttrades', 'htf_sma', or 'none'" }, 400, origin);
  }
  const validHtfs = FOREX_SMA_HTF_OPTIONS[timeframe];
  if (htf_timeframe !== undefined && !validHtfs.includes(htf_timeframe)) {
    return json({ error: `htf_timeframe for ${timeframe} must be one of: ${validHtfs.join(', ')}` }, 400, origin);
  }
  if (confirmation_mode !== undefined && !['mss', 'cisd', 'either'].includes(confirmation_mode)) {
    return json({ error: "confirmation_mode must be 'mss', 'cisd', or 'either'" }, 400, origin);
  }

  const asset = await env.DB.prepare(
    'SELECT asset_type FROM user_assets WHERE id=? AND user_id=?'
  ).bind(params.assetId, clerkUser.id).first();
  if (!asset || !['forex', 'crypto', 'commodity'].includes(asset.asset_type)) {
    return json({ error: 'Asset must be forex, crypto, or commodity.' }, 400, origin);
  }

  const existing = await env.DB.prepare(
    'SELECT id FROM forex_indicator_configs WHERE user_id=? AND asset_id=? AND timeframe=?'
  ).bind(clerkUser.id, params.assetId, timeframe).first();
  if (existing) {
    return json({ error: 'Config already exists for this timeframe on this asset.' }, 400, origin);
  }

  const finalBiasMode         = ['htf_sma', 'none'].includes(bias_mode) ? bias_mode : 'ttrades';
  const finalHtfTimeframe     = validHtfs.includes(htf_timeframe) ? htf_timeframe : validHtfs[0];
  const finalConfirmationMode = ['mss', 'cisd', 'either'].includes(confirmation_mode) ? confirmation_mode : 'either';

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO forex_indicator_configs (id, user_id, asset_id, indicator, timeframe, bias_mode, htf_timeframe, confirmation_mode, enabled, created_at)
    VALUES (?,?,?,'sma',?,?,?,?,1,?)
  `).bind(id, clerkUser.id, params.assetId, timeframe, finalBiasMode, finalHtfTimeframe, finalConfirmationMode, Date.now()).run();

  return json({
    id, indicator: 'sma', timeframe,
    bias_mode: finalBiasMode, htf_timeframe: finalHtfTimeframe, confirmation_mode: finalConfirmationMode, enabled: 1,
  }, 201, origin);
});

router.patch('/user/forex-indicator-configs/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const body = await req.json();

  if (body.bias_mode !== undefined && !['ttrades', 'htf_sma', 'none'].includes(body.bias_mode)) {
    return json({ error: "bias_mode must be 'ttrades', 'htf_sma', or 'none'" }, 400, origin);
  }
  if (body.confirmation_mode !== undefined && !['mss', 'cisd', 'either'].includes(body.confirmation_mode)) {
    return json({ error: "confirmation_mode must be 'mss', 'cisd', or 'either'" }, 400, origin);
  }

  // htf_timeframe validity depends on the config's timeframe, which isn't
  // itself patchable here — look it up rather than trusting the client.
  if (body.htf_timeframe !== undefined) {
    const existing = await env.DB.prepare(
      'SELECT timeframe FROM forex_indicator_configs WHERE id=? AND user_id=?'
    ).bind(params.id, clerkUser.id).first();
    if (!existing) return json({ error: 'Config not found.' }, 404, origin);
    const validHtfs = FOREX_SMA_HTF_OPTIONS[existing.timeframe] ?? [];
    if (!validHtfs.includes(body.htf_timeframe)) {
      return json({ error: `htf_timeframe must be one of: ${validHtfs.join(', ')}` }, 400, origin);
    }
  }

  const sets = []; const vals = [];
  if (body.enabled !== undefined)           { sets.push('enabled = ?');           vals.push(body.enabled ? 1 : 0); }
  if (body.bias_mode !== undefined)         { sets.push('bias_mode = ?');         vals.push(body.bias_mode); }
  if (body.htf_timeframe !== undefined)     { sets.push('htf_timeframe = ?');     vals.push(body.htf_timeframe); }
  if (body.confirmation_mode !== undefined) { sets.push('confirmation_mode = ?'); vals.push(body.confirmation_mode); }
  if (!sets.length) return json({ ok: true }, 200, origin);
  vals.push(clerkUser.id, params.id);
  await env.DB.prepare(`UPDATE forex_indicator_configs SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).bind(...vals).run();
  return json({ ok: true }, 200, origin);
});

router.delete('/user/forex-indicator-configs/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const config = await env.DB.prepare(
    'SELECT * FROM forex_indicator_configs WHERE id = ? AND user_id = ?'
  ).bind(params.id, clerkUser.id).first();

  await env.DB.prepare('DELETE FROM forex_indicator_configs WHERE id = ? AND user_id = ?').bind(params.id, clerkUser.id).run();

  if (config) {
    // forex_sma_state has no user_id — it's shared symbol+TF-level state.
    // Only clear it once no other user still has an active config on this
    // same symbol+TF, otherwise this would wipe their phase tracking too.
    const asset = await env.DB.prepare('SELECT symbol FROM user_assets WHERE id = ?').bind(config.asset_id).first();
    if (asset?.symbol) {
      const stillUsed = await env.DB.prepare(`
        SELECT COUNT(*) as cnt FROM forex_indicator_configs fic
        JOIN user_assets ua ON fic.asset_id = ua.id
        WHERE ua.symbol = ? AND fic.timeframe = ?
      `).bind(asset.symbol, config.timeframe).first();
      if ((stillUsed?.cnt ?? 0) === 0) {
        await env.DB.prepare(
          'DELETE FROM forex_sma_state WHERE symbol = ? AND timeframe = ?'
        ).bind(asset.symbol, config.timeframe).run();
      }
    }
  }

  return json({ ok: true }, 200, origin);
});

// ── Bias Cache ────────────────────────────────────────────────

router.get('/user/bias/:symbol', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const symbol = decodeURIComponent(params.symbol);
  const { results } = await env.DB.prepare(
    'SELECT timeframe, bias, updated_at FROM bias_cache WHERE symbol = ?'
  ).bind(symbol).all();
  const out = {};
  for (const row of (results ?? [])) out[row.timeframe] = { bias: row.bias, updated_at: row.updated_at };
  return json(out, 200, origin);
});

// ── Health / Data Sources ─────────────────────────────────────

router.get('/health/datasources', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const dayStart = Date.now() - 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT source, MAX(called_at) as lastCall, SUM(CASE WHEN called_at > ? THEN 1 ELSE 0 END) as callsToday,
     MAX(CASE WHEN called_at > ? THEN success ELSE 0 END) as lastSuccess
     FROM api_call_log GROUP BY source`
  ).bind(dayStart, dayStart).all();

  const { results: tdKeys } = await env.DB.prepare(
    `SELECT id FROM api_keys WHERE source='twelvedata' AND enabled=1`
  ).all();
  const keyIds = (tdKeys ?? []).map(k => k.id);

  const sources = { yahoo: { lastCall: null, callsToday: 0, lastSuccess: false } };
  for (const id of keyIds) sources[id] = { lastCall: null, callsToday: 0, lastSuccess: false };
  for (const r of (results ?? [])) {
    sources[r.source] = { lastCall: r.lastCall, callsToday: r.callsToday, lastSuccess: r.lastSuccess === 1 };
  }
  const twelvedataToday = keyIds.reduce((sum, id) => sum + (sources[id]?.callsToday ?? 0), 0);
  return json({ sources, twelvedataToday, twelvedataLimit: 800 * (keyIds.length || 1) }, 200, origin);
});

// ── Alerts ────────────────────────────────────────────────────

router.get('/alerts/history', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const url    = new URL(req.url);
  const type   = url.searchParams.get('type') ?? 'all';
  const limit  = parseInt(url.searchParams.get('limit') ?? '100');
  const days   = parseInt(url.searchParams.get('days') ?? '30');
  const assetId = url.searchParams.get('assetId');
  const since  = Date.now() - days * 24 * 60 * 60 * 1000;
  let query    = 'SELECT * FROM alert_history WHERE user_id = ? AND fired_at > ?';
  const params = [clerkUser.id, since];
  if (type !== 'all') { query += ' AND alert_type = ?'; params.push(type); }
  if (assetId) {
    const asset = await env.DB.prepare('SELECT symbol FROM user_assets WHERE id = ? AND user_id = ?').bind(assetId, clerkUser.id).first();
    if (asset) { query += ' AND symbol = ?'; params.push(asset.symbol); }
  }
  query += ' ORDER BY fired_at DESC LIMIT ?';
  params.push(limit);
  const alerts = await env.DB.prepare(query).bind(...params).all();
  return json(alerts.results ?? [], 200, origin);
});

router.get('/alerts/export', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const url    = new URL(req.url);
  const days   = url.searchParams.get('days');
  const from   = days ? Date.now() - parseInt(days) * 24 * 60 * 60 * 1000 : parseInt(url.searchParams.get('from') ?? '0');
  const to     = parseInt(url.searchParams.get('to') ?? String(Date.now()));
  const assetId = url.searchParams.get('assetId');
  const fromISO = new Date(from).toISOString();
  const toISO   = new Date(to).toISOString();
  let query    = 'SELECT * FROM alert_history WHERE user_id = ? AND fired_at >= ? AND fired_at <= ?';
  const params = [clerkUser.id, fromISO, toISO];
  if (assetId) {
    const asset = await env.DB.prepare('SELECT symbol FROM user_assets WHERE id = ? AND user_id = ?').bind(assetId, clerkUser.id).first();
    if (asset) { query += ' AND symbol = ?'; params.push(asset.symbol); }
  }
  query += ' ORDER BY fired_at DESC LIMIT 5000';
  const alerts = await env.DB.prepare(query).bind(...params).all();
  return json(alerts.results ?? [], 200, origin);
});

// ── Telegram ──────────────────────────────────────────────────

router.get('/user/telegram', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const tg = await env.DB.prepare(
    'SELECT verified, chat_id FROM user_telegram WHERE user_id = ?'
  ).bind(clerkUser.id).first();
  if (!tg) return json({ connected: false }, 200, origin);
  return json({
    connected: tg.verified === 1,
    chatIdMasked: tg.chat_id ? `••••${String(tg.chat_id).slice(-4)}` : null,
  }, 200, origin);
});

router.post('/user/telegram/initlink', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  await env.DB.prepare(`
    INSERT INTO user_telegram (user_id, chat_id, link_code, verified, updated_at)
    VALUES (?,''  ,?,0,?)
    ON CONFLICT(user_id) DO UPDATE SET link_code = ?, updated_at = ?
  `).bind(clerkUser.id, code, Date.now(), code, Date.now()).run();
  return json({ code }, 200, origin);
});



router.post('/user/telegram/test', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const tg = await env.DB.prepare(
    'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
  ).bind(clerkUser.id).first();
  if (!tg) return json({ error: 'Telegram not connected' }, 400, origin);
  await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id,
    '🔔 <b>Test alert from EBP Tracker</b>\n\nYour Telegram is connected and working correctly.'
  );
  return json({ success: true }, 200, origin);
});

// ── Market Breadth ────────────────────────────────────────────────

const BREADTH_CURRENCIES = ['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

// Trading-day key for an arbitrary UTC ms timestamp, using the 17:00 NY
// session boundary — same Intl shortOffset technique as nyDateAtHourToUTCms
// above, just applied to convert an instant to NY wall-clock instead of the
// other direction (date string + hour -> UTC ms).
function nyTradingDayKey(tsMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(tsMs));
  const offsetStr   = parts.find(p => p.type === 'timeZoneName').value;
  const offsetHours = parseInt(offsetStr.replace('GMT', ''));
  const nyWallClock = new Date(tsMs + offsetHours * 3600 * 1000);
  // Session rolls over at 17:00 NY — hours >=17 belong to the next trading day.
  if (nyWallClock.getUTCHours() >= 17) {
    nyWallClock.setUTCDate(nyWallClock.getUTCDate() + 1);
  }
  return nyWallClock.toISOString().slice(0, 10); // YYYY-MM-DD trading-day key
}

// EBP cron trigger — public route, secured by X-Cron-Secret (cron-job.org)
router.post('/cron/ebp', async (req, env) => {
  const origin = getOrigin(req);
  const secret = req.headers.get('X-Cron-Secret');
  if (!secret || secret !== env.CRON_SECRET) {
    return json({ error: 'Forbidden' }, 403, origin);
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const { tf } = body;
  if (!tf) return json({ error: 'tf required' }, 400, origin);

  try {
    const debugLog = [];
    const result = await handleEBPCron(tf, env, debugLog);
    return json({ ok: true, tf, fired_at: new Date().toISOString(), debug: debugLog, ...result }, 200, origin);
  } catch (err) {
    console.error(`EBP cron trigger error TF=${tf}:`, err.message);
    return json({ error: err.message }, 500, origin);
  }
});

// Market breadth snapshot — admin only
router.get('/market/breadth', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const cache = await env.DB.prepare(
    'SELECT * FROM market_breadth_cache WHERE tf = ?'
  ).bind('1H').first();

  if (!cache) {
    return json({ error: 'No breadth data yet — trigger POST /cron/ebp with {"tf":"BREADTH"} first' }, 404, origin);
  }

  const corr = await env.DB.prepare(
    'SELECT matrix FROM market_breadth_correlation WHERE tf = ?'
  ).bind('1H').first();

  // Widened from 48h to 35 days — the daily array needs up to 5 trading
  // days and the weekly array needs up to 5 ISO weeks of history; both are
  // built from this single read, matching compute-worker's own 35-day
  // weekly-aggregation cutoff. The `intraday` field below (still 1H rows)
  // is unchanged in shape, just now covers a longer span.
  const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
  const { results: intraday } = await env.DB.prepare(
    'SELECT snapshot_at, strength FROM market_breadth_intraday WHERE tf = ? AND snapshot_at >= ? ORDER BY snapshot_at ASC'
  ).bind('1H', cutoff).all();

  // ── Daily trading-day array — up to 5 most recent NY trading days that
  // actually have data, grouped by the 17:00 NY session boundary
  // (nyTradingDayKey) rather than calendar date. Index 0 = most recent.
  // Reuses the intraday rows already fetched above — no new read.
  const dayBuckets = new Map(); // trading-day key -> latest {t, strength} snapshot that day
  for (const row of intraday ?? []) {
    const key = nyTradingDayKey(row.snapshot_at);
    const existing = dayBuckets.get(key);
    if (!existing || row.snapshot_at > existing.t) {
      dayBuckets.set(key, { t: row.snapshot_at, strength: JSON.parse(row.strength) });
    }
  }
  const DAY_LABEL_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_LABEL_MONTHS   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDayLabel(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return `${DAY_LABEL_WEEKDAYS[dt.getUTCDay()]} ${DAY_LABEL_MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
  }
  const dailyArray = [...dayBuckets.entries()]
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, 5)
    .map(([dateKey, v]) => ({ date: dateKey, label: fmtDayLabel(dateKey), strength: v.strength }));

  // ── Weekly week array — up to 5 most recent ISO weeks (UTC Monday-Sunday
  // boundary, same algorithm as compute-worker's computeWeeklyBreadth's
  // getIsoWeekKey), averaged from the same intraday rows fetched above.
  function getIsoWeekKey(tsMs) {
    const d = new Date(tsMs);
    const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    thursday.setUTCDate(thursday.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
    return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }
  function getIsoWeekMondayMs(tsMs) {
    const d = new Date(tsMs);
    const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    thursday.setUTCDate(thursday.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
    return thursday.getTime() - 3 * 24 * 60 * 60 * 1000;
  }
  const WEEK_LABEL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtWeekLabel(mondayMs) {
    const d = new Date(mondayMs);
    return `Week of ${WEEK_LABEL_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  const nowWeekKey = getIsoWeekKey(Date.now());
  const weekBuckets = new Map(); // weekKey -> { mondayMs, sums, counts }
  for (const row of intraday ?? []) {
    const key = getIsoWeekKey(row.snapshot_at);
    if (!weekBuckets.has(key)) {
      weekBuckets.set(key, { mondayMs: getIsoWeekMondayMs(row.snapshot_at), sums: {}, counts: {} });
    }
    const w = weekBuckets.get(key);
    const strength = JSON.parse(row.strength);
    for (const ccy of BREADTH_CURRENCIES) {
      if (typeof strength[ccy] === 'number') {
        w.sums[ccy]   = (w.sums[ccy] ?? 0) + strength[ccy];
        w.counts[ccy] = (w.counts[ccy] ?? 0) + 1;
      }
    }
  }
  const weeksArray = [...weekBuckets.entries()]
    .sort((a, b) => b[1].mondayMs - a[1].mondayMs)
    .slice(0, 5)
    .map(([weekKey, w]) => {
      const strength = {};
      for (const ccy of BREADTH_CURRENCIES) {
        strength[ccy] = w.counts[ccy] > 0 ? parseFloat((w.sums[ccy] / w.counts[ccy]).toFixed(4)) : 0;
      }
      return { weekKey, label: fmtWeekLabel(w.mondayMs), strength, isCurrentWeek: weekKey === nowWeekKey };
    });

  const weeklyLast = await env.DB.prepare(
    'SELECT strength, computed_at FROM market_breadth_cache WHERE tf = ?'
  ).bind('1W').first();
  const weeklyCurrent = await env.DB.prepare(
    'SELECT strength, computed_at FROM market_breadth_cache WHERE tf = ?'
  ).bind('1W_current').first();

  return json({
    currencies:  BREADTH_CURRENCIES,
    heatmap:     JSON.parse(cache.heatmap),
    strength:    JSON.parse(cache.strength),
    computed_at: cache.computed_at,
    intraday:    (intraday ?? []).map(r => ({ t: r.snapshot_at, strength: JSON.parse(r.strength) })),
    correlation: corr ? JSON.parse(corr.matrix) : null,
    daily:       dailyArray,
    today:       dailyArray[0] ?? null,
    yesterday:   dailyArray[1] ?? null,
    weekly: {
      weeks: weeksArray,
      lastWeek: weeklyLast
        ? { strength: JSON.parse(weeklyLast.strength), computed_at: weeklyLast.computed_at }
        : null,
      thisWeek: weeklyCurrent
        ? { strength: JSON.parse(weeklyCurrent.strength), computed_at: weeklyCurrent.computed_at }
        : null,
    },
  }, 200, origin);
});

// Telegram bot webhook — public route, no Clerk auth
router.post('/telegram/webhook', async (req, env) => {
  const origin = getOrigin(req);
  try {
    const body    = await req.json();
    const message = body?.message;
    if (!message) return json({ ok: true }, 200, origin);

    const chatId = message.chat?.id?.toString();
    const text   = (message.text ?? '').trim();

    if (text === '/start' || text.startsWith('/start ')) {
      await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId,
        '👋 <b>Welcome to EBP Tracker Bot!</b>\n\nTo connect your account:\n1. Go to your EBP Tracker dashboard\n2. Open Settings → Telegram\n3. Click \"Get Connection Code\"\n4. Send the 4-digit code here\n\nWaiting for your code...'
      );
      return json({ ok: true }, 200, origin);
    }

    if (/^\d{4}$/.test(text)) {
      const record = await env.DB.prepare(
        'SELECT user_id FROM user_telegram WHERE link_code = ?'
      ).bind(text).first();

      if (!record) {
        await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId,
          '❌ Invalid or expired code. Please get a new code from Settings → Telegram on the dashboard.'
        );
        return json({ ok: true }, 200, origin);
      }

      await env.DB.prepare(
        'UPDATE user_telegram SET chat_id = ?, verified = 1, link_code = NULL, updated_at = ? WHERE user_id = ?'
      ).bind(chatId, Date.now(), record.user_id).run();

      await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId,
        '✅ <b>EBP Tracker connected!</b>\n\nYou will now receive EBP alerts here.\n\nGo back to the dashboard to configure your assets and alert preferences.'
      );
      return json({ ok: true }, 200, origin);
    }

    await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId,
      '🤖 Send your 4-digit connection code to link your account.\n\nGet the code from Settings → Telegram on the EBP Tracker dashboard.'
    );
    return json({ ok: true }, 200, origin);

  } catch (err) {
    console.error('Webhook error:', err.message);
    return json({ ok: true }, 200, origin);
  }
});

// Poll endpoint — frontend polls to check if bot verified the code
router.post('/user/telegram/verify', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const tg = await env.DB.prepare(
    'SELECT verified, chat_id FROM user_telegram WHERE user_id = ?'
  ).bind(clerkUser.id).first();
  if (!tg) return json({ verified: false }, 200, origin);
  return json({
    verified: tg.verified === 1,
    chatIdMasked: tg.chat_id ? '••••' + String(tg.chat_id).slice(-4) : null,
  }, 200, origin);
});

// Disconnect Telegram
router.delete('/user/telegram', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  await env.DB.prepare(
    "UPDATE user_telegram SET verified = 0, chat_id = '', updated_at = ? WHERE user_id = ?"
  ).bind(Date.now(), clerkUser.id).run();
  return json({ success: true }, 200, origin);
});

// ── Trade Journal — Signal ID lookup/linking ─────────
// Secured by X-Journal-Secret (a shared secret with the Trade Journal app),
// not Clerk auth — these routes are never reached with req._ctx's clerkUser.

router.get('/signals/:id', async (req, env) => {
  const { params } = req._ctx;
  const secret = req.headers.get('X-Journal-Secret');
  if (!secret || secret !== env.JOURNAL_API_SECRET) {
    return journalJson({ error: 'Unauthorised' }, 401);
  }
  const row = await env.DB.prepare('SELECT * FROM signals WHERE signal_id = ?').bind(params.id).first();
  if (!row) return journalJson({ error: 'Signal not found' }, 404);
  return journalJson(row, 200);
});

router.patch('/signals/:id/traded', async (req, env) => {
  const { params } = req._ctx;
  const secret = req.headers.get('X-Journal-Secret');
  if (!secret || secret !== env.JOURNAL_API_SECRET) {
    return journalJson({ error: 'Unauthorised' }, 401);
  }
  const result = await env.DB.prepare('UPDATE signals SET traded = 1 WHERE signal_id = ?').bind(params.id).run();
  if (result.meta.changes === 0) return journalJson({ error: 'Signal not found' }, 404);
  return journalJson({ ok: true }, 200);
});

// ── Sweep (moved from Sweep Worker) ────────────────────

router.get('/sweep/dashboard', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const assets = await env.DB.prepare(`
    SELECT ua.id as asset_id, ua.symbol
    FROM user_assets ua
    WHERE ua.user_id = ?
  `).bind(clerkUser.id).all();

  const result = [];
  for (const asset of (assets.results ?? [])) {
    const { results: configs } = await env.DB.prepare(
      'SELECT timeframe FROM user_sweep_configs WHERE asset_id = ? AND enabled = 1'
    ).bind(asset.asset_id).all();
    const tfs    = (configs ?? []).map(c => c.timeframe);
    const status = {};

    for (const tf of tfs) {
      const candles = await getCandlesFromCache(asset.symbol, tf, env);
      status[tf] = (candles && candles.length >= 2) ? (detectSweep(candles)?.direction ?? 'none') : 'none';
    }

    result.push({ symbol: asset.symbol, sweepStatus: status });
  }

  return json(result, 200, origin);
});

router.get('/sweep/history', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const url    = new URL(req.url);
  const limit  = parseInt(url.searchParams.get('limit') ?? '50');
  const alerts = await env.DB.prepare(`
    SELECT * FROM alert_history
    WHERE user_id = ? AND alert_type = 'sweep'
    ORDER BY fired_at DESC LIMIT ?
  `).bind(clerkUser.id, limit).all();

  return json(alerts.results ?? [], 200, origin);
});

// ============================================================
// Main fetch handler
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const origin   = getOrigin(request);
    const url      = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method   = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      // /signals is called cross-origin by the Trade Journal app, which isn't
      // in ALLOWED_ORIGINS — those routes are secured by X-Journal-Secret
      // instead, so they need open CORS rather than the strict allowlist.
      if (pathname.startsWith('/signals')) {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Journal-Secret',
          },
        });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Match route
    const match = router.match(method, pathname);
    if (!match) {
      return json({ error: 'Not found', path: pathname }, 404, origin);
    }

    // Auth — attempt token verification, attach result to request context
    let clerkUser = null;
    let authError = null;
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      try {
        clerkUser = await verifyClerkToken(
          authHeader.replace('Bearer ', ''),
          env.CLERK_SECRET_KEY
        );
      } catch (e) {
        authError = e.message;
      }
    }

    // Attach context to request object
    request._ctx = {
      user:   clerkUser,
      error:  authError,
      origin,
      params: match.params,
    };

    try {
      return await match.handlers[0](request, env, ctx);
    } catch (err) {
      console.error('Handler error:', err);
      return json({ error: 'Internal server error', detail: err.message }, 500, origin);
    }
  },
};
