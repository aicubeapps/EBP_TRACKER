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

function getHTFForTF(tf) {
  const map = { 'M15': '4H', '1H': 'D', '4H': 'W', 'D': 'W', 'W': null };
  return map[tf] ?? null;
}

// ── Phase 3 — Bias Source Map ─────────────────────────────────
const BIAS_SOURCE = {
  ebp:      { 'M15': '4H', '1H': 'D', '4H': 'W', 'D': 'W', 'W': null },
  sweep:    { 'M5': '1H', 'M15': '1H', 'M30': '4H', '1H': 'D', '4H': 'W' },
  template: { 'W': null, 'D': 'W', '4H': 'D', '1H': '4H' },
};

const INTERVAL_MS = {
  'M5':  5  * 60 * 1000,
  'M15': 15 * 60 * 1000,
  'M30': 30 * 60 * 1000,
  '1H':  60 * 60 * 1000,
  '4H':  4  * 60 * 60 * 1000,
  'D':   24 * 60 * 60 * 1000,
  'W':   7  * 24 * 60 * 60 * 1000,
};

// Twelve Data and Yahoo both include the currently-forming candle as the
// most recent element — confirmed empirically (live 1H fetch mid-candle
// returned it as index 0/last-pushed). Filtering it out here, once, means
// every downstream consumer (detectEBP, detectSweep, updateSwingState,
// bias calc) only ever sees fully closed candles.
function getClosedCandles(candles, intervalMs) {
  if (!intervalMs) return candles; // unknown tf — don't silently drop everything
  const now = Date.now();
  return candles.filter(c => {
    const openMs = typeof c.time === 'number' ? c.time : new Date(c.time).getTime();
    return openMs + intervalMs <= now;
  });
}

// HTF bias display label, keyed by the ACTUAL bias timeframe used for a
// given alert (not the signal's own tf) — necessary since per-user
// htf_override means different users on the same symbol+tf can have a
// different HTF bias source.
function getHTFBiasLabel(biasTF) {
  const map = { '4H': '4H HTF bias', 'D': '1D HTF bias', 'W': '1W HTF bias', '1H': '1H HTF bias' };
  return map[biasTF] ?? `${biasTF} HTF bias`;
}

// User-configurable HTF bias pairing. M15/M30/D/W stay fixed to
// BIAS_SOURCE's default; only 1H and 4H can be overridden, and only to one
// of two allowed alternates.
const VALID_HTF_OVERRIDES = {
  '1H': ['4H', 'D'],
  '4H': ['D', 'W'],
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

async function loadBiasCache(db, symbol, biasTF) {
  return db.prepare(
    'SELECT * FROM bias_cache WHERE symbol=? AND timeframe=?'
  ).bind(symbol, biasTF).first();
}

// ── Phase 3 — T3 Chain State Machine ─────────────────────────

async function initiateT3Chain(db, userId, assetId, symbol, direction, htfTf, ltf, windowMins) {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO chain_state
    (id,user_id,asset_id,symbol,template,direction,current_step,htf_tf,ltf,htf_signal_time,expires_at,created_at)
    VALUES (?,?,?,?,?,?,2,?,?,?,?,?)
  `).bind(
    crypto.randomUUID(), userId, assetId, symbol,
    't3', direction, htfTf, ltf, now,
    now + (windowMins * 60 * 1000), now
  ).run();
}

async function advanceT3Chain(db, chainId, ltfSweepTime) {
  await db.prepare(
    'UPDATE chain_state SET current_step=3, ltf_sweep_time=? WHERE id=?'
  ).bind(ltfSweepTime, chainId).run();
}

async function completeT3Chain(db, chainId) {
  await db.prepare('DELETE FROM chain_state WHERE id=?').bind(chainId).run();
}

async function getActiveChains(db, userId, symbol, template, direction, step) {
  const res = await db.prepare(`
    SELECT * FROM chain_state
    WHERE user_id=? AND symbol=? AND template=? AND direction=? AND current_step=? AND expires_at > ?
  `).bind(userId, symbol, template, direction, step, Date.now()).all();
  return res.results ?? [];
}

async function cleanupExpiredChains(db) {
  await db.prepare('DELETE FROM chain_state WHERE expires_at < ?').bind(Date.now()).run();
}

function formatT3Alert(symbol, direction, htfTf, ltfTf, htfBar, ltfBar, mssBar) {
  const dir     = direction === 'bullish' ? '🟢 Bullish' : '🔴 Bearish';
  const htfTime = new Date(htfBar.time).toUTCString().slice(5, 22);
  const ltfTime = new Date(ltfBar.time).toUTCString().slice(5, 22);
  const mssTime = new Date(mssBar.time).toUTCString().slice(5, 22);
  return [
    `⛓ T3 Chain Complete — ${symbol}`,
    `Direction: ${dir}`,
    `Step 1 — ${htfTf} EBP: ${htfTime}`,
    `Step 2 — ${ltfTf} Sweep: ${ltfTime}`,
    `Step 3 — ${ltfTf} MSS: ${mssTime}`,
  ].join('\n');
}

function tfToTwelveInterval(tf) {
  const map = {
    'M5': '5min', 'M15': '15min', 'M30': '30min',
    '1H': '1h', '4H': '4h', 'D': '1day', 'W': '1week',
  };
  return map[tf] ?? '1h';
}

// ============================================================
// Data Feed
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

function toYahooInterval(tf) {
  const map = {
    'M5': '5m', 'M15': '15m', 'M30': '30m',
    '1H': '1h', '4H': '1h', 'D': '1d', 'W': '1wk',
  };
  return map[tf] ?? '1h';
}

async function fetchYahooFinance(symbol, tf, outputSize = 3) {
  const yahooSymbol = toYahooSymbol(symbol);
  const interval    = toYahooInterval(tf);
  const rangeMap    = {
    'M5': '1d', 'M15': '5d', 'M30': '5d',
    '1H': '5d', '4H': '60d', 'D': '1mo', 'W': '3mo',
  };
  const range = rangeMap[tf] ?? '5d';
  const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${interval}&range=${range}`;
  const res   = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data  = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: no data for ${symbol}`);
  const timestamps = result.timestamp;
  const ohlc       = result.indicators.quote[0];
  const candles    = [];
  for (let i = timestamps.length - 1; i >= 0 && candles.length < outputSize; i--) {
    if (ohlc.close[i] == null) continue;
    candles.push({
      open:  ohlc.open[i],
      high:  ohlc.high[i],
      low:   ohlc.low[i],
      close: ohlc.close[i],
      time:  timestamps[i] * 1000,
    });
  }
  return candles;
}

async function logApiCall(db, source, symbol, timeframe, success = 1) {
  try {
    await db.prepare(
      'INSERT INTO api_call_log (id, source, symbol, timeframe, called_at, success) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), source, symbol, timeframe, Date.now(), success).run();
  } catch {}
}

// ── Twelve Data key rotation ──────────────────────────────
// Keys live in D1 (api_keys, source='twelvedata') rather than being a fixed
// env-var list, so rotation works dynamically regardless of how many keys
// are configured. A key that comes back exhausted (daily credit cap) is
// marked and skipped until the next UTC midnight instead of failing the
// whole fetch. Falls through to Yahoo only once every key is exhausted.

function nextMidnightUTC() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
}

async function resetExhaustedKeys(db) {
  const now = Date.now();
  await db.prepare(
    `UPDATE api_key_state
     SET exhausted=0, calls_today=0, exhausted_at=NULL, reset_at=?
     WHERE exhausted=1 AND reset_at < ?`
  ).bind(nextMidnightUTC(), now).run();
}

async function ensureKeyStateRow(db, keyName) {
  await db.prepare(
    `INSERT OR IGNORE INTO api_key_state (key_name, exhausted, calls_today, reset_at) VALUES (?, 0, 0, 0)`
  ).bind(keyName).run();
}

async function getActiveTwelveDataKey(db) {
  await resetExhaustedKeys(db);

  const { results } = await db.prepare(`
    SELECT ak.id, ak.key_value, ak.label,
           COALESCE(aks.exhausted, 0) as exhausted,
           COALESCE(aks.calls_today, 0) as calls_today
    FROM api_keys ak
    LEFT JOIN api_key_state aks ON ak.id = aks.key_name
    WHERE ak.source='twelvedata' AND ak.enabled=1
    ORDER BY ak.label ASC
  `).all();

  for (const row of (results ?? [])) {
    if (row.exhausted === 0) {
      return { keyName: row.id, apiKey: row.key_value, label: row.label };
    }
  }
  return null; // all keys exhausted (or none configured) — fall through to Yahoo
}

async function markKeyExhausted(db, keyName) {
  const now = Date.now();
  await db.prepare(
    `UPDATE api_key_state SET exhausted=1, exhausted_at=?, reset_at=? WHERE key_name=?`
  ).bind(now, nextMidnightUTC(), keyName).run();
  console.warn(`[ROTATION] ${keyName} exhausted — rotating to next key`);
}

async function incrementKeyCallCount(db, keyName) {
  await db.prepare(
    `UPDATE api_key_state SET calls_today=calls_today+1 WHERE key_name=?`
  ).bind(keyName).run();
}

// Twelve Data's `datetime` field is NY-local wall-clock text (the URL
// requests timezone=America/New_York) — e.g. "2026-07-28 23:00:00", or
// "2026-07-28" for daily/weekly bars. `new Date(str).getTime()` mislabels
// those digits as UTC (confirmed against production candle_cache: a
// TD-sourced 1H bar was stored 4 hours early), so convert via the actual
// NY UTC offset (EDT/EST) instead.
function nyLocalStringToUTCms(str) {
  const iso     = str.includes(' ') ? str.replace(' ', 'T') : `${str}T00:00:00`;
  const naiveMs = Date.parse(`${iso}Z`); // digits taken as if they were UTC
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset'
  }).formatToParts(new Date(naiveMs));
  const offsetStr    = parts.find(p => p.type === 'timeZoneName').value;
  const offsetHours  = parseInt(offsetStr.replace('GMT', ''));
  return naiveMs - offsetHours * 3600 * 1000;
}

function isTwelveDataExhausted(data) {
  if (data?.code === 429) return true;
  if (data?.status === 'error' && data?.message?.toLowerCase().includes('run out')) return true;
  if (data?.status === 'error' && data?.message?.toLowerCase().includes('api credits')) return true;
  return false;
}

async function fetchTwelveDataWithRotation(symbol, tf, db, env, count = 10) {
  const interval = tfToTwelveInterval(tf);

  const maxAttempts = 5; // safety cap — more than the realistic key count
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const active = await getActiveTwelveDataKey(db);
    if (!active) break; // all keys exhausted (or none configured)

    await ensureKeyStateRow(db, active.keyName);

    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${count}&order=DESC&timezone=America/New_York&apikey=${active.apiKey}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[TWELVE_DATA] HTTP ${res.status} for ${symbol} ${tf} on ${active.label}`);
        return null;
      }

      const data = await res.json();

      if (isTwelveDataExhausted(data)) {
        await markKeyExhausted(db, active.keyName);
        continue; // try next key
      }

      if (data.status === 'error' || !data.values || data.values.length < 3) {
        console.warn(`[TWELVE_DATA] No data for ${symbol} ${tf} on ${active.label}: ${data.message ?? 'unknown'}`);
        return null; // symbol error — don't rotate, just fail
      }

      await incrementKeyCallCount(db, active.keyName);
      await logApiCall(db, active.keyName, symbol, tf, 1);

      return data.values.map(v => ({
        open:  parseFloat(v.open),
        high:  parseFloat(v.high),
        low:   parseFloat(v.low),
        close: parseFloat(v.close),
        time:  nyLocalStringToUTCms(v.datetime),
      }));

    } catch (e) {
      console.error(`[TWELVE_DATA] Fetch error ${symbol} ${tf} on ${active.label}: ${e.message}`);
      return null;
    }
  }

  return null; // all keys exhausted or failed
}

async function fetchCandles(symbol, tf, db, env, count = 10) {
  symbol = normaliseSymbol(symbol);

  // 1. Twelve Data — primary (3-key rotation)
  const twelveCandlesRaw = await fetchTwelveDataWithRotation(symbol, tf, db, env, count);
  const twelveCandles = twelveCandlesRaw ? getClosedCandles(twelveCandlesRaw, INTERVAL_MS[tf]) : null;
  if (twelveCandles && twelveCandles.length >= 3) return twelveCandles;

  // 2. Yahoo Finance — final fallback (unlimited, no key)
  try {
    const yahooCandlesRaw = await fetchYahooFinance(symbol, tf, count);
    const yahooCandles = getClosedCandles(yahooCandlesRaw, INTERVAL_MS[tf]);
    if (yahooCandles && yahooCandles.length >= 3) {
      await logApiCall(db, 'yahoo', symbol, tf);
      return yahooCandles;
    }
  } catch (e) {
    console.warn(`Yahoo failed ${symbol} ${tf}: ${e.message}`);
  }

  console.error(`[FETCH] All sources failed ${symbol} ${tf}`);
  return null;
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

async function validateSymbol(symbol, apiKey) {
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

function fmtNY(ts) {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit',
    month: 'short', day: 'numeric',
  });
}

// ── Phase I addendum — trading session at signal fire time ─────
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

// ============================================================
// FVG Engine (Phase 1)
// ============================================================

function detectFVG(candles) {
  const [c0, c1, c2] = candles; // [oldest, middle, newest]
  if (c2.low > c0.high) {
    return { direction: 'bullish', zone_low: c0.high, zone_high: c2.low, midpoint: (c0.high + c2.low) / 2, formed_at: c2.time, candle_time: c1.time };
  }
  if (c2.high < c0.low) {
    return { direction: 'bearish', zone_low: c2.high, zone_high: c0.low, midpoint: (c2.high + c0.low) / 2, formed_at: c2.time, candle_time: c1.time };
  }
  return null;
}

function checkFVGMitigation(fvg, candle, rule) {
  if (rule === '50_percent') {
    if (fvg.direction === 'bullish' && candle.low <= fvg.midpoint)  return true;
    if (fvg.direction === 'bearish' && candle.high >= fvg.midpoint) return true;
  }
  if (rule === 'body_close') {
    const bodyLow  = Math.min(candle.open, candle.close);
    const bodyHigh = Math.max(candle.open, candle.close);
    if (bodyLow >= fvg.zone_low && bodyHigh <= fvg.zone_high) return true;
  }
  return false;
}

function isPriceInFVG(fvg, candle) {
  return candle.low <= fvg.zone_high && candle.high >= fvg.zone_low;
}

async function processFVGs(db, symbol, timeframe, candles, latestCandle) {
  const now    = Date.now();
  const TTL_MS = 7 * 24 * 60 * 60 * 1000;

  const fvg = detectFVG(candles);
  if (fvg) {
    const tol      = fvg.zone_low * 0.001;
    const existing = await db.prepare(
      `SELECT id FROM detected_fvgs WHERE symbol=? AND timeframe=? AND mitigated=0
       AND ABS(zone_low-?)<?  AND ABS(zone_high-?)<? LIMIT 1`
    ).bind(symbol, timeframe, fvg.zone_low, tol, fvg.zone_high, tol).first();

    if (!existing) {
      await db.prepare(
        `INSERT INTO detected_fvgs
         (id,symbol,timeframe,direction,zone_low,zone_high,midpoint,formed_at,candle_time,expires_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        crypto.randomUUID(), symbol, timeframe, fvg.direction,
        fvg.zone_low, fvg.zone_high, fvg.midpoint,
        fvg.formed_at, fvg.candle_time, fvg.formed_at + TTL_MS, now
      ).run();
    }
  }

  const { results: activeFVGs } = await db.prepare(
    `SELECT * FROM detected_fvgs WHERE symbol=? AND timeframe=? AND mitigated=0 AND expires_at>?`
  ).bind(symbol, timeframe, now).all();

  for (const activeFVG of activeFVGs) {
    const rule = activeFVG.mitigation_rule || '50_percent';
    if (checkFVGMitigation(activeFVG, latestCandle, rule)) {
      await db.prepare(`UPDATE detected_fvgs SET mitigated=1, mitigated_at=? WHERE id=?`)
        .bind(now, activeFVG.id).run();
    }
  }
}

async function cleanupExpiredFVGs(db) {
  const now = Date.now();
  await db.prepare(`UPDATE detected_fvgs SET mitigated=1, mitigated_at=? WHERE mitigated=0 AND expires_at<?`)
    .bind(now, now).run();
}

// ============================================================
// Swing State + MSS Engine (Phase 1.5 + 2)
// ============================================================

function getCandleDirection(candle, priorDirection) {
  if (candle.close > candle.open) return 'bullish';
  if (candle.close < candle.open) return 'bearish';
  return priorDirection;
}

async function updateSwingState(db, symbol, timeframe, candles) {
  // candles = [oldest, middle, newest]
  const currentCandle = candles[2];
  const now = Date.now();

  const state = await db.prepare(
    `SELECT * FROM swing_state WHERE symbol=? AND timeframe=?`
  ).bind(symbol, timeframe).first();

  if (!state) {
    const dir = currentCandle.close >= currentCandle.open ? 'bullish' : 'bearish';
    await db.prepare(
      `INSERT INTO swing_state
       (symbol,timeframe,run_direction,run_start,run_extreme,extreme_time,updated_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      symbol, timeframe, dir, currentCandle.time,
      dir === 'bullish' ? currentCandle.high : currentCandle.low,
      currentCandle.time, now
    ).run();
    return null;
  }

  const currentDir = getCandleDirection(currentCandle, state.run_direction);
  let newState = { ...state };

  if (currentDir === state.run_direction) {
    if (currentDir === 'bullish' && currentCandle.high > state.run_extreme) {
      newState.run_extreme  = currentCandle.high;
      newState.extreme_time = currentCandle.time;
    } else if (currentDir === 'bearish' && currentCandle.low < state.run_extreme) {
      newState.run_extreme  = currentCandle.low;
      newState.extreme_time = currentCandle.time;
    }
  } else {
    if (state.run_direction === 'bullish') {
      newState.confirmed_swing_high      = state.run_extreme;
      newState.confirmed_swing_high_time = state.extreme_time;
    } else {
      newState.confirmed_swing_low      = state.run_extreme;
      newState.confirmed_swing_low_time = state.extreme_time;
    }
    newState.run_direction = currentDir;
    newState.run_start     = currentCandle.time;
    newState.run_extreme   = currentDir === 'bullish' ? currentCandle.high : currentCandle.low;
    newState.extreme_time  = currentCandle.time;
  }

  newState.updated_at = now;

  await db.prepare(
    `INSERT INTO swing_state
     (symbol,timeframe,run_direction,run_start,run_extreme,extreme_time,
      confirmed_swing_high,confirmed_swing_high_time,
      confirmed_swing_low,confirmed_swing_low_time,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol,timeframe) DO UPDATE SET
       run_direction=excluded.run_direction,
       run_start=excluded.run_start,
       run_extreme=excluded.run_extreme,
       extreme_time=excluded.extreme_time,
       confirmed_swing_high=excluded.confirmed_swing_high,
       confirmed_swing_high_time=excluded.confirmed_swing_high_time,
       confirmed_swing_low=excluded.confirmed_swing_low,
       confirmed_swing_low_time=excluded.confirmed_swing_low_time,
       updated_at=excluded.updated_at`
  ).bind(
    symbol, timeframe,
    newState.run_direction, newState.run_start, newState.run_extreme, newState.extreme_time,
    newState.confirmed_swing_high ?? null, newState.confirmed_swing_high_time ?? null,
    newState.confirmed_swing_low  ?? null, newState.confirmed_swing_low_time  ?? null,
    newState.updated_at
  ).run();

  return detectMSS(newState, currentCandle);
}

function detectMSS(swingState, currentCandle) {
  if (
    swingState.run_direction === 'bearish' &&
    swingState.confirmed_swing_high != null &&
    currentCandle.close > swingState.confirmed_swing_high
  ) {
    return { direction: 'bullish', level: swingState.confirmed_swing_high, candle_time: currentCandle.time };
  }
  if (
    swingState.run_direction === 'bullish' &&
    swingState.confirmed_swing_low != null &&
    currentCandle.close < swingState.confirmed_swing_low
  ) {
    return { direction: 'bearish', level: swingState.confirmed_swing_low, candle_time: currentCandle.time };
  }
  return null;
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

// ============================================================
// Candle Cache
// ============================================================
async function updateCandleCache(db, symbol, tf, candles) {
  const [b0, b1, b2] = candles;
  await db.prepare(`
    INSERT OR REPLACE INTO candle_cache
    (symbol, timeframe,
     bar_0_open, bar_0_high, bar_0_low, bar_0_close,
     bar_1_open, bar_1_high, bar_1_low, bar_1_close,
     bar_2_open, bar_2_high, bar_2_low, bar_2_close,
     bar_0_time, bar_1_time, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    symbol, tf,
    b0?.open??null, b0?.high??null, b0?.low??null, b0?.close??null,
    b1?.open??null, b1?.high??null, b1?.low??null, b1?.close??null,
    b2?.open??null, b2?.high??null, b2?.low??null, b2?.close??null,
    b0?.time??null, b1?.time??null, Date.now()
  ).run();
}

// ── Phase I — EBP Signal IDs (M15/1H/4H/1D — not W, separate counters from T3/NSE) ──
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
// Daily candle synthesis — Twelve Data / Yahoo's `D` interval is midnight
// UTC aligned, but forex daily candles actually open at 5 PM NY (21:00 UTC
// in EDT, 22:00 UTC in EST). Synthesise the correct daily bar from closed
// 1H candles instead of trusting the provider's D interval.
// ============================================================
function getNYUTCBoundaryHour(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset'
  }).formatToParts(new Date(nowMs));
  const offsetStr = parts.find(p => p.type === 'timeZoneName').value;
  const offset = parseInt(offsetStr.replace('GMT', ''));
  const boundary = 17 - offset; // 5 PM NY in UTC: EDT(-4)→21, EST(-5)→22
  return (boundary === 21 || boundary === 22) ? boundary : 21; // fallback to EDT
}

function synthesiseDailyCandle(hourlyCandles, boundaryHour) {
  // hourlyCandles: closed 1H candles (any order); boundaryHour: UTC hour of
  // 5 PM NY open (21 or 22). Returns { bar0, bar1 } — most recent two
  // completed forex days, newest first — or nulls when data is insufficient.
  function getDayIndex(candleMs) {
    const adjusted = new Date(candleMs - boundaryHour * 3600 * 1000);
    return adjusted.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  const groups = {};
  for (const c of hourlyCandles) {
    const openMs = typeof c.time === 'number' ? c.time : new Date(c.time).getTime();
    const day = getDayIndex(openMs);
    if (!groups[day]) groups[day] = [];
    groups[day].push({ ...c, openMs });
  }

  const days = Object.keys(groups).sort().reverse(); // most recent first
  if (days.length < 2) return { bar0: null, bar1: null };

  function aggregate(candles) {
    if (candles.length < 20) return null; // too many gaps, unreliable
    const sorted = [...candles].sort((a, b) => a.openMs - b.openMs);
    return {
      open:  sorted[0].open,
      high:  Math.max(...sorted.map(c => c.high)),
      low:   Math.min(...sorted.map(c => c.low)),
      close: sorted[sorted.length - 1].close,
      time:  sorted[0].openMs,
    };
  }

  return {
    bar0: aggregate(groups[days[0]]),
    bar1: aggregate(groups[days[1]]),
  };
}

// fetchCandles() already filters to closed candles internally (both the
// Twelve Data and Yahoo branches run getClosedCandles before returning).
async function fetchSynthesizedDailyBars(symbol, env) {
  const rawHourly = await fetchCandles(symbol, '1H', env.DB, env, 52);
  if (!rawHourly) return { bar0: null, bar1: null };
  const boundaryHour = getNYUTCBoundaryHour(Date.now());
  return synthesiseDailyCandle(rawHourly, boundaryHour);
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
        // Forex daily candles open at 5 PM NY, not midnight UTC — synthesise
        // from closed 1H candles instead of the provider's D interval.
        const { bar0, bar1 } = await fetchSynthesizedDailyBars(symbol, env);
        if (!bar0 || !bar1) {
          log(`[${symbol}] SKIP: insufficient closed 1H candles for daily synthesis`);
          continue;
        }
        candles = [bar0, bar1];
      } else {
        candles = await fetchCandles(symbol, tf, env.DB, env, 10);
        if (!candles || candles.length < 2) {
          log(`[${symbol}] SKIP: insufficient candles`);
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
        // 'D' HTF bias (used by 1H default / 1H+4H overrides) has the same
        // midnight-UTC misalignment as the Daily TF itself — synthesise it too.
        let htfCandles;
        if (htf === 'D') {
          const { bar0, bar1 } = await fetchSynthesizedDailyBars(symbol, env);
          htfCandles = (bar0 && bar1) ? [bar0, bar1] : null;
        } else {
          htfCandles = await fetchCandles(symbol, htf, env.DB, env, 10);
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

      await updateCandleCache(env.DB, symbol, tf, candles);

      // FVG Phase 1 — candles are newest-first; processFVGs needs oldest-first.
      // Daily TF only has the two synthesised bars (bar0/bar1) — FVG needs 3,
      // so it's skipped there, but swing state / MSS still run on bar0.
      let mssResult = null;
      if (tf === 'D') {
        mssResult = await updateSwingState(env.DB, symbol, tf, [null, null, candles[0]]);
      } else if (candles.length >= 3) {
        const oldestFirst = [candles[2], candles[1], candles[0]];
        await processFVGs(env.DB, symbol, tf, oldestFirst, candles[0]);

        // Phase 1.5 + 2 — Swing state + MSS
        mssResult = await updateSwingState(env.DB, symbol, tf, oldestFirst);
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

          const msg = formatMSSAlert(symbol, tf, mssResult, userHtfBias, getHTFBiasLabel(userBiasTF));
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);

          await env.DB.prepare(
            `INSERT INTO alert_history
             (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
             VALUES (?,?,?,?,?,?,?,?,'mss')`
          ).bind(
            crypto.randomUUID(), row.user_id, symbol, tf,
            mssResult.direction, userHtfBias, mssResult.candle_time, Date.now()
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
        if (alertMode === 'aligned' && !trendAligned) continue;

        const tg = await env.DB.prepare(
          'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
        ).bind(row.user_id).first();
        if (!tg?.chat_id) continue;

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

        await env.DB.prepare(`
          INSERT INTO alert_history
          (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
          VALUES (?,?,?,?,?,?,?,?,'ebp')
        `).bind(
          crypto.randomUUID(), row.user_id, symbol, tf,
          ebp.direction, effectiveBias, ebp.candleTime, Date.now()
        ).run();

        // T3 chain initiation
        const tmpl = await env.DB.prepare(
          `SELECT * FROM user_templates WHERE user_id=? AND asset_id=? AND template='t3' AND enabled=1 AND htf=?`
        ).bind(row.user_id, row.asset_id, tf).first();
        if (tmpl) {
          await initiateT3Chain(
            env.DB, row.user_id, row.asset_id, symbol,
            ebp.direction, tf, tmpl.ltf, tmpl.window_mins
          );
        }
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      const msg = `Error ${symbol} ${tf}: ${err.message}`;
      console.error(msg);
      if (debugLog) debugLog.push(`[ERROR] ${msg}`);
    }
  }

  return { symbolsProcessed: symbolMap.size };
}

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

  // Fetch Clerk JWKS to verify signature
  const jwksRes = await fetch('https://api.clerk.com/v1/jwks', {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const jwks = await jwksRes.json();

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
      const cache = await env.DB.prepare(
        'SELECT * FROM candle_cache WHERE symbol = ? AND timeframe = ?'
      ).bind(asset.symbol, tf).first();
      if (cache) {
        const ebp  = detectEBP([
          { open: cache.bar_0_open, high: cache.bar_0_high, low: cache.bar_0_low, close: cache.bar_0_close, time: cache.bar_0_time },
          { open: cache.bar_1_open, high: cache.bar_1_high, low: cache.bar_1_low, close: cache.bar_1_close, time: cache.bar_1_time },
        ]);
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
  if (assetType !== 'nse') {
    const count = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND asset_type != 'nse'"
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

  if (assetType !== 'forex' && assetType !== 'crypto') {
    // NSE ('nse') and any unrecognised type still go through Yahoo validation.
    // Forex/crypto symbols come from the hardcoded asset browser list, so
    // they're guaranteed valid and skip this call entirely.
    const validation = await validateSymbol(symbolStr, env.TWELVE_DATA_API_KEY);
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
    "SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND asset_type != 'nse'"
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

  const active = await getActiveTwelveDataKey(env.DB);

  if (!active) {
    // All keys exhausted (or none configured) — fall back to a plain guess
    return json({ valid: true, symbol, asset_type: guessAssetType(symbol), source: 'fallback' }, 200, origin);
  }

  try {
    const res  = await fetch(
      `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(symbol)}&outputsize=5&apikey=${active.apiKey}`
    );
    const data = await res.json();

    if (!data.data || data.data.length === 0) {
      return json({ valid: false, error: 'Symbol not found' }, 200, origin);
    }

    const match = data.data.find(d =>
      d.symbol.toUpperCase() === symbol.toUpperCase() ||
      d.symbol.toUpperCase().replace('/', '') === symbol.toUpperCase().replace('/', '')
    ) ?? data.data[0];

    const asset_type = mapTwelveDataType(match.instrument_type);

    return json({
      valid: true,
      symbol,
      asset_type,
      exchange: match.exchange,
      name: match.instrument_name,
    }, 200, origin);

  } catch (e) {
    return json({ valid: true, symbol, asset_type: guessAssetType(symbol), source: 'fallback' }, 200, origin);
  }
});

function mapTwelveDataType(instrumentType) {
  if (!instrumentType) return 'forex';
  const t = instrumentType.toUpperCase();
  if (t === 'FOREX PAIR' || t === 'PHYSICAL CURRENCY') return 'forex';
  if (t === 'DIGITAL CURRENCY') return 'crypto';
  if (t === 'INDEX') return 'index';
  if (t === 'ETF') return 'etf';
  if (t === 'COMMON STOCK') return 'equity';
  if (t === 'COMMODITY') return 'commodity';
  return 'forex';
}

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
  const { enabled, htf, ltf, window_mins } = await req.json();
  if (htf && ltf && TEMPLATE_TF_RANK[ltf] >= TEMPLATE_TF_RANK[htf]) {
    return json({ error: 'LTF must be strictly lower than HTF' }, 400, origin);
  }
  await env.DB.prepare(
    'UPDATE user_templates SET enabled=COALESCE(?,enabled), htf=COALESCE(?,htf), ltf=COALESCE(?,ltf), window_mins=COALESCE(?,window_mins) WHERE id=? AND user_id=?'
  ).bind(enabled ?? null, htf ?? null, ltf ?? null, window_mins ?? null, params.id, clerkUser.id).run();
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

// ── NSE Indicator Configs (TDI / SMA Cloud — Phase D++) ────────

router.get('/user/nse-indicator-configs/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM nse_indicator_configs WHERE asset_id=? AND user_id=? ORDER BY created_at ASC'
  ).bind(params.assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
});

router.post('/user/nse-indicator-configs/:assetId', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const { indicator, timeframe, stack_mode, day_filter, bias_mode, htf_timeframe } = await req.json();

  if (indicator !== 'tdi' && indicator !== 'sma') {
    return json({ error: "indicator must be 'tdi' or 'sma'" }, 400, origin);
  }

  const validTfs = indicator === 'tdi' ? ['M15', 'M30'] : ['M15', 'M5'];
  if (!validTfs.includes(timeframe)) {
    return json({ error: `timeframe must be one of: ${validTfs.join(', ')}` }, 400, origin);
  }

  if (indicator === 'sma' && bias_mode !== undefined && !['ttrades', 'htf_sma'].includes(bias_mode)) {
    return json({ error: "bias_mode must be 'ttrades' or 'htf_sma'" }, 400, origin);
  }
  if (indicator === 'sma' && htf_timeframe !== undefined && !['M30', '1H'].includes(htf_timeframe)) {
    return json({ error: "htf_timeframe must be 'M30' or '1H'" }, 400, origin);
  }

  const existing = await env.DB.prepare(
    'SELECT id FROM nse_indicator_configs WHERE user_id=? AND asset_id=? AND indicator=? AND timeframe=?'
  ).bind(clerkUser.id, params.assetId, indicator, timeframe).first();
  if (existing) {
    return json({ error: 'Config already exists for this indicator/timeframe on this asset.' }, 400, origin);
  }

  const finalStackMode    = indicator === 'sma' ? (stack_mode === 'loose' ? 'loose' : 'strict') : null;
  const finalDayFilter    = indicator === 'sma' ? (day_filter === 0 ? 0 : 1) : null;
  const finalBiasMode     = indicator === 'sma' ? (bias_mode === 'htf_sma' ? 'htf_sma' : 'ttrades') : null;
  const finalHtfTimeframe = indicator === 'sma' ? (htf_timeframe === 'M30' ? 'M30' : '1H') : null;

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO nse_indicator_configs (id, user_id, asset_id, indicator, timeframe, stack_mode, day_filter, enabled, created_at, bias_mode, htf_timeframe)
    VALUES (?,?,?,?,?,?,?,1,?,?,?)
  `).bind(id, clerkUser.id, params.assetId, indicator, timeframe, finalStackMode, finalDayFilter, Date.now(), finalBiasMode, finalHtfTimeframe).run();

  return json({
    id, indicator, timeframe, stack_mode: finalStackMode, day_filter: finalDayFilter,
    bias_mode: finalBiasMode, htf_timeframe: finalHtfTimeframe, enabled: 1,
  }, 201, origin);
});

router.patch('/user/nse-indicator-configs/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const body = await req.json();

  if (body.bias_mode !== undefined && !['ttrades', 'htf_sma'].includes(body.bias_mode)) {
    return json({ error: "bias_mode must be 'ttrades' or 'htf_sma'" }, 400, origin);
  }
  if (body.htf_timeframe !== undefined && !['M30', '1H'].includes(body.htf_timeframe)) {
    return json({ error: "htf_timeframe must be 'M30' or '1H'" }, 400, origin);
  }

  const sets = []; const vals = [];
  if (body.enabled !== undefined)       { sets.push('enabled = ?');       vals.push(body.enabled ? 1 : 0); }
  if (body.stack_mode !== undefined)    { sets.push('stack_mode = ?');    vals.push(body.stack_mode === 'loose' ? 'loose' : 'strict'); }
  if (body.day_filter !== undefined)    { sets.push('day_filter = ?');    vals.push(body.day_filter ? 1 : 0); }
  if (body.bias_mode !== undefined)     { sets.push('bias_mode = ?');     vals.push(body.bias_mode); }
  if (body.htf_timeframe !== undefined) { sets.push('htf_timeframe = ?'); vals.push(body.htf_timeframe); }
  if (!sets.length) return json({ ok: true }, 200, origin);
  vals.push(clerkUser.id, params.id);
  await env.DB.prepare(`UPDATE nse_indicator_configs SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).bind(...vals).run();
  return json({ ok: true }, 200, origin);
});

router.delete('/user/nse-indicator-configs/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const config = await env.DB.prepare(
    'SELECT * FROM nse_indicator_configs WHERE id = ? AND user_id = ?'
  ).bind(params.id, clerkUser.id).first();

  await env.DB.prepare('DELETE FROM nse_indicator_configs WHERE id = ? AND user_id = ?').bind(params.id, clerkUser.id).run();

  if (config) {
    if (config.indicator === 'tdi') {
      // nse_indicator_chain is per-user (has user_id) — safe to delete unconditionally.
      await env.DB.prepare(
        'DELETE FROM nse_indicator_chain WHERE user_id = ? AND asset_id = ? AND timeframe = ?'
      ).bind(clerkUser.id, config.asset_id, config.timeframe).run();
    } else if (config.indicator === 'sma') {
      // nse_sma_state has no user_id — it's shared symbol+TF-level state. Only
      // clear it once no other user still has an active SMA config on this
      // same symbol+TF, otherwise this would wipe their phase tracking too.
      const asset = await env.DB.prepare('SELECT symbol FROM user_assets WHERE id = ?').bind(config.asset_id).first();
      if (asset?.symbol) {
        const stillUsed = await env.DB.prepare(`
          SELECT COUNT(*) as cnt FROM nse_indicator_configs ic
          JOIN user_assets ua ON ic.asset_id = ua.id
          WHERE ua.symbol = ? AND ic.timeframe = ? AND ic.indicator = 'sma'
        `).bind(asset.symbol, config.timeframe).first();
        if ((stillUsed?.cnt ?? 0) === 0) {
          await env.DB.prepare(
            'DELETE FROM nse_sma_state WHERE symbol = ? AND timeframe = ?'
          ).bind(asset.symbol, config.timeframe).run();
        }
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
  let query    = 'SELECT * FROM alert_history WHERE user_id = ? AND fired_at >= ? AND fired_at <= ?';
  const params = [clerkUser.id, from, to];
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
  const BREADTH_TF = '1H';
  const now = Date.now();

  // Fetch 10 candles per pair for strength history and correlation.
  const pairData = {};
  for (const [pair, base, quote] of MAJOR_PAIRS) {
    const candles = await fetchCandles(pair, BREADTH_TF, env.DB, env, 10);
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

  // Append intraday snapshot, prune rows older than 48 hours.
  await env.DB.prepare(
    'INSERT OR REPLACE INTO market_breadth_intraday (tf, snapshot_at, strength) VALUES (?,?,?)'
  ).bind(BREADTH_TF, now, JSON.stringify(strength)).run();
  await env.DB.prepare(
    'DELETE FROM market_breadth_intraday WHERE tf = ? AND snapshot_at < ?'
  ).bind(BREADTH_TF, now - 48 * 60 * 60 * 1000).run();

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
  return { pairs_fetched: Object.keys(pairData).length };
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
    let result;
    if (tf === 'BREADTH') {
      result = await handleMarketBreadthCron(env, debugLog);
    } else {
      result = await handleEBPCron(tf, env, debugLog);
    }
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
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);

  const cache = await env.DB.prepare(
    'SELECT * FROM market_breadth_cache WHERE tf = ?'
  ).bind('1H').first();

  if (!cache) {
    return json({ error: 'No breadth data yet — trigger POST /cron/ebp with {"tf":"BREADTH"} first' }, 404, origin);
  }

  const corr = await env.DB.prepare(
    'SELECT matrix FROM market_breadth_correlation WHERE tf = ?'
  ).bind('1H').first();

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const { results: intraday } = await env.DB.prepare(
    'SELECT snapshot_at, strength FROM market_breadth_intraday WHERE tf = ? AND snapshot_at >= ? ORDER BY snapshot_at ASC'
  ).bind('1H', cutoff).all();

  return json({
    currencies:  BREADTH_CURRENCIES,
    heatmap:     JSON.parse(cache.heatmap),
    strength:    JSON.parse(cache.strength),
    computed_at: cache.computed_at,
    intraday:    (intraday ?? []).map(r => ({ t: r.snapshot_at, strength: JSON.parse(r.strength) })),
    correlation: corr ? JSON.parse(corr.matrix) : null,
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

// ── Admin ─────────────────────────────────────────────────────

async function requireAdmin(clerkUser, db) {
  const u = await db.prepare('SELECT is_admin FROM users WHERE id = ?').bind(clerkUser.id).first();
  return u?.is_admin === 1;
}

router.get('/admin/users', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const users = await env.DB.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM user_assets WHERE user_id = u.id) as asset_count,
      (SELECT COUNT(*) FROM alert_history WHERE user_id = u.id) as alert_count,
      (SELECT verified FROM user_telegram WHERE user_id = u.id) as telegram_verified
    FROM users u ORDER BY u.created_at DESC
  `).all();
  return json(users.results ?? [], 200, origin);
});

router.get('/admin/tokens', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const tokens = await env.DB.prepare(
    'SELECT * FROM invite_tokens ORDER BY created_at DESC'
  ).all();
  return json(tokens.results ?? [], 200, origin);
});

router.post('/admin/invite', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const token = crypto.randomUUID().split('-')[0].toUpperCase();
  await env.DB.prepare(
    'INSERT INTO invite_tokens (token, created_at) VALUES (?,?)'
  ).bind(token, Date.now()).run();
  const appUrl = env.APP_URL ?? 'https://ebp-tracker.pages.dev';
  return json({ token, url: `${appUrl}/invite/${token}` }, 201, origin);
});

router.post('/admin/expire/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  await env.DB.prepare(
    'UPDATE users SET active = 0, expires_at = ? WHERE id = ?'
  ).bind(Date.now(), params.id).run();
  return json({ success: true }, 200, origin);
});

// ── API key management ───────────────────────────────────────

router.get('/admin/api-keys', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { results } = await env.DB.prepare(`
    SELECT ak.id, ak.source, ak.label, ak.enabled, ak.added_at,
           COALESCE(aks.exhausted, 0) as exhausted,
           COALESCE(aks.calls_today, 0) as calls_today,
           '****' || substr(ak.key_value, -4) as key_preview
    FROM api_keys ak
    LEFT JOIN api_key_state aks ON ak.id = aks.key_name
    ORDER BY ak.source, ak.label ASC
  `).all();
  return json(results ?? [], 200, origin);
});

router.post('/admin/api-keys', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { source, key_value, label } = await req.json();
  if (!source || !key_value || !label) return json({ error: 'source, key_value, label required' }, 400, origin);
  const id  = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO api_keys (id, source, key_value, label, enabled, added_at, added_by) VALUES (?,?,?,?,1,?,?)`
  ).bind(id, source, key_value, label, now, clerkUser.id).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO api_key_state (key_name, exhausted, calls_today, reset_at) VALUES (?,0,0,0)`
  ).bind(id).run();
  return json({ ok: true, id }, 201, origin);
});

router.patch('/admin/api-keys/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { enabled } = await req.json();
  await env.DB.prepare(`UPDATE api_keys SET enabled=? WHERE id=?`).bind(enabled ? 1 : 0, params.id).run();
  return json({ ok: true }, 200, origin);
});

router.delete('/admin/api-keys/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  await env.DB.prepare(`DELETE FROM api_keys WHERE id=?`).bind(params.id).run();
  await env.DB.prepare(`DELETE FROM api_key_state WHERE key_name=?`).bind(params.id).run();
  return json({ ok: true }, 200, origin);
});

// ── Per-user asset limit ──────────────────────────────────────

router.patch('/admin/users/:id/asset-limit', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { asset_limit } = await req.json();
  if (!asset_limit || asset_limit < 1 || asset_limit > 50) {
    return json({ error: 'asset_limit must be between 1 and 50' }, 400, origin);
  }
  await env.DB.prepare(`UPDATE users SET asset_limit=? WHERE id=?`).bind(asset_limit, params.id).run();
  return json({ ok: true, asset_limit }, 200, origin);
});

router.get('/admin/users/:id/assets', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const assets = await env.DB.prepare(
    'SELECT symbol, asset_type, added_at FROM user_assets WHERE user_id = ? ORDER BY added_at ASC'
  ).bind(params.id).all();
  return json(assets.results ?? [], 200, origin);
});

const ALL_TF_ACCESS = ['M5', 'M15', 'M30', '1H', '4H', 'D', 'W'];

router.get('/admin/users/:id/tf-access', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const row = await env.DB.prepare('SELECT user_tf_access FROM users WHERE id=?').bind(params.id).first();
  if (!row) return json({ error: 'User not found' }, 404, origin);
  const tfAccess = JSON.parse(row.user_tf_access || JSON.stringify(ALL_TF_ACCESS));
  return json({ user_id: params.id, tf_access: tfAccess }, 200, origin);
});

router.patch('/admin/users/:id/tf-access', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { tf_access } = await req.json();
  if (!Array.isArray(tf_access) || tf_access.some(tf => !ALL_TF_ACCESS.includes(tf))) {
    return json({ error: `tf_access must be an array containing only: ${ALL_TF_ACCESS.join(', ')}` }, 400, origin);
  }
  await env.DB.prepare(`UPDATE users SET user_tf_access=? WHERE id=?`).bind(JSON.stringify(tf_access), params.id).run();
  return json({ ok: true }, 200, origin);
});

const ALL_NSE_TF_ACCESS = ['M1', 'M5', 'M15', 'M30', '1H', 'D'];

router.get('/admin/users/:id/nse-tf-access', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const row = await env.DB.prepare('SELECT nse_tf_access FROM users WHERE id=?').bind(params.id).first();
  if (!row) return json({ error: 'User not found' }, 404, origin);
  const nseTfAccess = JSON.parse(row.nse_tf_access || JSON.stringify(ALL_NSE_TF_ACCESS));
  return json({ user_id: params.id, nse_tf_access: nseTfAccess }, 200, origin);
});

router.patch('/admin/users/:id/nse-tf-access', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const { nse_tf_access } = await req.json();
  if (!Array.isArray(nse_tf_access) || nse_tf_access.some(tf => !ALL_NSE_TF_ACCESS.includes(tf))) {
    return json({ error: `nse_tf_access must be an array containing only: ${ALL_NSE_TF_ACCESS.join(', ')}` }, 400, origin);
  }
  await env.DB.prepare(`UPDATE users SET nse_tf_access=? WHERE id=?`).bind(JSON.stringify(nse_tf_access), params.id).run();
  return json({ ok: true }, 200, origin);
});

// GET /nse/status — public, no auth required. Dashboard uses this to show
// the "~15 min delayed" badge for non-admin users, who can't call
// GET /admin/api-keys directly.
router.get('/nse/status', async (req, env) => {
  const { origin } = req._ctx;
  const key = await env.DB.prepare(
    "SELECT id FROM api_keys WHERE source='upstox' AND enabled=1 LIMIT 1"
  ).first();
  return json({ upstox_configured: !!key }, 200, origin);
});

// GET /nse/search — proxies Yahoo Finance's symbol search server-side.
// Yahoo's endpoint sends no Access-Control-Allow-Origin header, so the
// frontend can't call it directly from the browser; this route exists
// purely to route around that CORS gap.
const NSE_KNOWN_INDICES = ['^NSEI', '^NSEBANK', '^BSESN', '^NIFTYBANK'];

router.get('/nse/search', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const url = new URL(req.url);
  const q   = (url.searchParams.get('q') ?? '').trim();
  if (!q) return json([], 200, origin);

  try {
    const yahooRes = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&lang=en-IN&region=IN`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data   = await yahooRes.json();
    const quotes = data?.quotes ?? [];
    const results = quotes
      .filter(item =>
        NSE_KNOWN_INDICES.includes(item.symbol) ||
        (/^[A-Z0-9&-]+\.NS$/.test(item.symbol ?? '') && item.quoteType === 'EQUITY')
      )
      .map(item => ({ symbol: item.symbol, shortName: item.shortname ?? item.longname ?? item.symbol }));
    return json(results, 200, origin);
  } catch (e) {
    return json({ error: 'Search failed' }, 502, origin);
  }
});

// ── Trade Journal — Signal ID lookup/linking (Phase I) ─────────
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

// ── Invite token validation ───────────────────────────────────

router.get('/invite/:token', async (req, env) => {
  const { origin, params } = req._ctx;
  const record = await env.DB.prepare(
    'SELECT * FROM invite_tokens WHERE token = ? AND active = 1 AND used_by IS NULL'
  ).bind(params.token).first();
  if (!record) return json({ valid: false, error: 'Invalid or already used token' }, 400, origin);
  return json({ valid: true, token: params.token }, 200, origin);
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

  // Cloudflare scheduled handler — not used (cron-job.org handles scheduling
  // via POST /cron/ebp; no [triggers] block in wrangler.toml calls this)
  async scheduled(event, env, ctx) {
    console.log('Scheduled event received — scheduling handled via cron-job.org HTTP triggers');
  },
};
