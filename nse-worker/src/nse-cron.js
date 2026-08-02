// ============================================================
// NSE Worker — Cron Logic
//
// Fully standalone — no cross-package imports. Detection functions
// (calcTTradesBias, detectEBP, detectSweep, updateSwingState,
// detectMSS) are copied verbatim from worker/src/ebp-worker.js and
// sweep-worker/src/sweep-cron.js.
// ============================================================

const NSE_BIAS_SOURCE = {
  ebp:   { 'M1': 'M15', 'M5': 'M30', 'M15': '1H', 'M30': 'D', '1H': 'D', 'D': null },
  sweep: { 'M1': 'M15', 'M5': 'M30', 'M15': '1H', 'M30': 'D', '1H': 'D', 'D': null },
};

const NSE_VALID_TFS = ['M1', 'M5', 'M15', 'M30', '1H', 'D'];

const INTERVAL_MS = {
  'M1':  1  * 60 * 1000,
  'M5':  5  * 60 * 1000,
  'M15': 15 * 60 * 1000,
  'M30': 30 * 60 * 1000,
  '1H':  60 * 60 * 1000,
  'D':   24 * 60 * 60 * 1000,
};

// Twelve Data and Yahoo both include the currently-forming candle as the
// most recent element — confirmed empirically against the EBP Worker's
// data sources (same providers). Filtering it out here, once, means every
// downstream consumer (detectEBP, detectSweep, updateSwingState, TDI, SMA
// Cloud) only ever sees fully closed candles. Applied to the Upstox path
// too, defensively — harmless even if Upstox's historical-candle endpoint
// already excludes the live bar, since every already-closed candle passes
// the filter trivially.
function getClosedCandles(candles, intervalMs) {
  if (!intervalMs) return candles; // unknown tf — don't silently drop everything
  const now = Date.now();
  return candles.filter(c => {
    const openMs = typeof c.time === 'number' ? c.time : new Date(c.time).getTime();
    return openMs + intervalMs <= now;
  });
}

// asset_type is always 'nse' in this system — there's no 'nse_index' /
// 'nse_asset' split in the schema or live data. Index-vs-equity for
// volume-gating is derived from the symbol itself instead (same list
// ebp-worker.js's /nse/search uses to identify index tickers).
const NSE_KNOWN_INDICES = ['^NSEI', '^NSEBANK', '^BSESN', '^NIFTYBANK'];
function isNseIndexSymbol(symbol) {
  return NSE_KNOWN_INDICES.includes(symbol);
}

// ── Market hours ──────────────────────────────────────────────
// NSE trades 9:15–15:30 IST, Mon–Fri. IST is UTC+5:30 year-round
// (India does not observe DST), so this window is fixed, unlike
// the EBP Worker's NY-close DST issue.
function isNseMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMinutes >= 225 && utcMinutes <= 600;
  // 3:45 UTC = 225min (9:15 IST), 10:00 UTC = 600min (3:30 IST)
}

function normaliseTicker(symbol) {
  return symbol
    .replace('^', '')
    .replace('.NS', '')
    .replace('.BO', '')
    .toUpperCase();
}

// ── Signal IDs ────────────────────────────────────────────────
// Single global 'NSE' counter shared across EBP/Sweep/MSS — the
// signal_id string itself doesn't distinguish signal type (unlike
// T3/T4's per-template counters); `signals.template_type` does that.
async function generateNseSignalId(env, symbol) {
  const row = await env.DB.prepare(
    `SELECT series, count FROM signal_counters WHERE template = 'NSE'`
  ).first();

  let series = row?.series ?? 'A';
  let count  = (row?.count ?? 0) + 1;
  if (count > 999) {
    series = String.fromCharCode(series.charCodeAt(0) + 1);
    count = 1;
  }

  await env.DB.prepare(`
    INSERT INTO signal_counters (template, series, count) VALUES ('NSE', ?, ?)
    ON CONFLICT(template) DO UPDATE SET series = excluded.series, count = excluded.count
  `).bind(series, count).run();

  return `NSE-${normaliseTicker(symbol)}-${series}${count.toString().padStart(3, '0')}`;
}

// ── Data feed — Upstox (when token present) → Yahoo (fallback) ─

function toUpstoxInstrumentKey(symbol) {
  const indexMap = {
    '^NSEI':      'NSE_INDEX|Nifty 50',
    '^NSEBANK':   'NSE_INDEX|Nifty Bank',
    '^NIFTYBANK': 'NSE_INDEX|Nifty Bank',
    '^BSESN':     'BSE_INDEX|SENSEX',
  };
  if (indexMap[symbol]) return indexMap[symbol];
  if (symbol.endsWith('.NS')) return `NSE_EQ|${symbol.replace('.NS', '')}`;
  if (symbol.endsWith('.BO')) return `BSE_EQ|${symbol.replace('.BO', '')}`;
  return symbol;
}

async function fetchUpstoxNse(symbol, tf, token) {
  const upstoxInterval = { 'M1': '1minute', 'M5': '5minute', 'M15': '15minute', 'M30': '30minute', '1H': '60minute', 'D': 'day' };
  const interval       = upstoxInterval[tf] ?? 'day';
  const instrumentKey  = toUpstoxInstrumentKey(symbol);

  const toDate   = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/${interval}/${toDate}/${fromDate}`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Upstox HTTP ${res.status}`);

  const data = await res.json();
  const raw  = data?.data?.candles;
  if (!raw || raw.length === 0) throw new Error('Upstox: no candles');

  // Upstox candle rows: [timestamp, open, high, low, close, volume, oi]
  const candles = raw.map(c => ({
    time:  new Date(c[0]).getTime(),
    open:  c[1], high: c[2], low: c[3], close: c[4],
    volume: c[5] ?? 0,
  }));
  candles.sort((a, b) => b.time - a.time); // guarantee newest-first
  return candles;
}

async function fetchYahooFinanceNse(symbol, tf) {
  const yahooInterval = { 'M1': '1m', 'M5': '5m', 'M15': '15m', 'M30': '30m', '1H': '60m', 'D': '1d' };
  const yahooRange    = { 'M1': '1d', 'M5': '5d', 'M15': '5d', 'M30': '1mo', '1H': '1mo', 'D': '1y' };
  const interval = yahooInterval[tf] ?? '1d';
  const range    = yahooRange[tf] ?? '1mo';

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: no data for ${symbol}`);

  const timestamps = result.timestamp;
  const ohlc       = result.indicators.quote[0];
  const candles    = [];
  // Capped at 60 (not the original 10) — the NSE Indicators feature needs up
  // to 60 candles (BB(34)/RSI(13)) when Yahoo is the fallback; harmless for
  // existing EBP/Sweep/MSS callers that only ever read the first 2-3.
  for (let i = timestamps.length - 1; i >= 0 && candles.length < 60; i--) {
    if (ohlc.close[i] == null) continue;
    candles.push({
      open:  ohlc.open[i],
      high:  ohlc.high[i],
      low:   ohlc.low[i],
      close: ohlc.close[i],
      time:  timestamps[i] * 1000,
      volume: ohlc.volume?.[i] ?? 0,
    });
  }
  return candles;
}

async function fetchNseCandles(symbol, tf, env) {
  const upstoxKey = await env.DB.prepare(
    "SELECT key_value FROM api_keys WHERE source='upstox' AND enabled=1 LIMIT 1"
  ).first();

  if (upstoxKey) {
    try {
      const raw = await fetchUpstoxNse(symbol, tf, upstoxKey.key_value);
      const candles = raw ? getClosedCandles(raw, INTERVAL_MS[tf]) : null;
      if (candles && candles.length >= 3) return candles;
    } catch (e) {
      console.warn(`[NSE] Upstox failed ${symbol} ${tf}, falling back to Yahoo: ${e.message}`);
    }
  }

  try {
    const raw = await fetchYahooFinanceNse(symbol, tf);
    return getClosedCandles(raw, INTERVAL_MS[tf]);
  } catch (e) {
    console.error(`[NSE] Yahoo failed ${symbol} ${tf}: ${e.message}`);
    return null;
  }
}

// ── Phase D++ — NSE Indicators — rolling 60-candle cache ────────
// Fetches fresh candles via the existing Upstox/Yahoo fallback, merges with
// whatever's cached (deduped by timestamp, fresh wins on collision), trims
// to 60, writes back. Writes to nse_indicator_candle_cache — a new table,
// distinct from nse_candle_cache (that one's fixed 3-bar layout stays as-is
// for the already-live EBP/Sweep/MSS path).
// Merges already-fetched candles into the cache (no fetch of its own) —
// used by handleNseCron, which already fetched `candles` once at the top
// of its per-symbol loop for EBP/Sweep/MSS. Calling a function that fetches
// internally here would mean two Upstox calls per symbol+TF per run,
// violating "one Upstox fetch per asset per TF per run regardless of
// indicator count."
async function mergeAndCacheNSECandles(symbol, timeframe, freshCandles, env) {
  if (!freshCandles || freshCandles.length === 0) return null;

  const cachedRow = await env.DB.prepare(
    'SELECT candles FROM nse_indicator_candle_cache WHERE symbol = ? AND timeframe = ?'
  ).bind(symbol, timeframe).first();

  let cached = [];
  if (cachedRow?.candles) {
    try { cached = JSON.parse(cachedRow.candles); } catch { cached = []; }
  }

  const merged = new Map(); // time -> candle; fresh overwrites cached on collision
  for (const c of cached) merged.set(c.time, c);
  for (const c of freshCandles) merged.set(c.time, c);

  const combined = [...merged.values()].sort((a, b) => b.time - a.time).slice(0, 60);

  await env.DB.prepare(`
    INSERT INTO nse_indicator_candle_cache (symbol, timeframe, candles, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe) DO UPDATE SET
      candles = excluded.candles, updated_at = excluded.updated_at
  `).bind(symbol, timeframe, JSON.stringify(combined), Date.now()).run();

  return combined;
}

// HTF candles for SMA Cloud's bias-reference leg — small fetch, no caching
// (fresh each run). htfTimeframe is per-config ('M30' or '1H'). Reuses the
// same Upstox-then-Yahoo fallback as everything else.
async function fetchHTFCandles(symbol, htfTimeframe, env) {
  const candles = await fetchNseCandles(symbol, htfTimeframe, env);
  if (!candles) return null;
  return candles.slice(0, 15);
}

// ── Phase D++ — NSE Indicators — shared math helpers (pure, stateless) ──

// RSI — Wilder smoothing. candles: newest-first array of {close}.
// Returns RSI values newest-first (length = candles.length - period).
function computeRSI(candles, period = 13) {
  const closes = [...candles].reverse().map(c => c.close); // oldest-first
  if (closes.length < period + 1) return [];

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  const rsiOldestFirst = new Array(closes.length).fill(null);
  rsiOldestFirst[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsiOldestFirst[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }

  const result = [];
  for (let i = closes.length - 1; i >= period; i--) result.push(rsiOldestFirst[i]);
  return result; // newest-first
}

// SMA — simple moving average. values: oldest-first. Returns array same
// length as input (null for the first period-1 entries).
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

// Bollinger Bands on an arbitrary series (used here on the RSI series).
// values: oldest-first. Returns { upper, middle, lower } arrays, same
// length as input, index-aligned (null before period-1).
function computeBB(values, period = 34, stdDevMult = 1.6185) {
  const middle = computeSMA(values, period);
  const upper  = new Array(values.length).fill(null);
  const lower  = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const slice    = values.slice(i - period + 1, i + 1);
    const mean     = middle[i];
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const stdDev   = Math.sqrt(variance);
    upper[i] = mean + stdDev * stdDevMult;
    lower[i] = mean - stdDev * stdDevMult;
  }
  return { upper, middle, lower };
}

// ── TTrades bias engine — copied verbatim from worker/src/ebp-worker.js ──
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

// ── EBP detection — copied verbatim from worker/src/ebp-worker.js ──
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

// ── Sweep detection — copied verbatim from sweep-worker/src/sweep-cron.js ──
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

// ── FVG engine — copied verbatim from sweep-worker/src/sweep-cron.js ──
// NSE FVG TFs are M5/M15/1H only (enforced by the caller in handleNseCron).
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

function checkFVGMitigation(bar, fvgRow) {
  if (fvgRow.direction === 'bullish') return bar.close < fvgRow.midpoint;
  return bar.close > fvgRow.midpoint;
}

async function processFVGZones(db, symbol, tf, candlesOldestFirst, latestBar) {
  const nowISO = new Date().toISOString();

  const fvg = detectFVG(candlesOldestFirst);
  if (fvg) {
    const existing = await db.prepare(
      `SELECT id FROM nse_fvg_zones WHERE symbol=? AND tf=? AND direction=? AND mitigated_at IS NULL AND expires_at > ?
       AND top >= ? AND bottom <= ? LIMIT 1`
    ).bind(symbol, tf, fvg.direction, nowISO, fvg.bottom, fvg.top).first();

    if (!existing) {
      const formedAtISO = new Date(fvg.formed_at).toISOString();
      const expiresAt   = new Date(fvg.formed_at + 14 * 24 * 60 * 60 * 1000).toISOString();
      await db.prepare(
        `INSERT INTO nse_fvg_zones (symbol, tf, direction, top, bottom, midpoint, formed_at, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(symbol, tf, fvg.direction, fvg.top, fvg.bottom, fvg.midpoint, formedAtISO, expiresAt, nowISO).run();
    }
  }

  const { results: activeFVGs } = await db.prepare(
    `SELECT * FROM nse_fvg_zones WHERE symbol=? AND tf=? AND mitigated_at IS NULL AND expires_at > ?`
  ).bind(symbol, tf, nowISO).all();

  for (const row of activeFVGs ?? []) {
    if (checkFVGMitigation(latestBar, row)) {
      await db.prepare(`UPDATE nse_fvg_zones SET mitigated_at=?, mitigated_by_tf=? WHERE id=?`)
        .bind(nowISO, tf, row.id).run();
    }
  }
}

async function cleanupExpiredNseFVGs(db) {
  const nowISO = new Date().toISOString();
  await db.prepare(`DELETE FROM nse_fvg_zones WHERE expires_at < ?`).bind(nowISO).run();
}

// ── Swing state + MSS — copied verbatim from worker/src/ebp-worker.js ──
// Own nse_swing_states table (not the shared forex/crypto swing_states) —
// NSE runs an M1 timeframe forex/crypto never uses and this keeps the two
// fully independent.
function isDoji(bar, dojiThreshold) {
  return Math.abs(bar.close - bar.open) <= dojiThreshold;
}

// Real ATR(14) when enough history is passed in; the D1 candle cache this
// file reads from only ever exposes the 3-bar window already used
// elsewhere here, so this returns null in practice and callers fall back
// to (high-low)*0.1 per the Phase 1.5 spec.
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

// Only the newest bar (candlesOldestFirst's last element) is a genuinely
// new close each cron cycle — the array's second-to-last element is used
// only as the comparison bar when bootstrapping run_dir from empty state.
async function updateSwingState(db, symbol, timeframe, candlesOldestFirst) {
  const bar     = candlesOldestFirst[candlesOldestFirst.length - 1];
  const prevBar = candlesOldestFirst[candlesOldestFirst.length - 2] ?? null;
  const nowISO  = new Date().toISOString();

  let state = await db.prepare(`SELECT * FROM nse_swing_states WHERE symbol=? AND tf=?`).bind(symbol, timeframe).first();
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
      state.run_dir            = mssResult.direction;
      state.pending_swing_high = null; state.pending_swing_high_time = null;
      state.pending_swing_low  = null; state.pending_swing_low_time  = null;
      state.run_candle_count   = 1;
      state.run_start_time     = barTimeISO;
    }
  }

  state.updated_at = nowISO;
  await db.prepare(`
    INSERT INTO nse_swing_states (symbol, tf, run_dir, run_start_time, run_candle_count,
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
    symbol, timeframe, state.run_dir, state.run_start_time, state.run_candle_count,
    state.last_confirmed_swing_high, state.last_confirmed_swing_high_time,
    state.last_confirmed_swing_low, state.last_confirmed_swing_low_time,
    state.pending_swing_high, state.pending_swing_high_time,
    state.pending_swing_low, state.pending_swing_low_time,
    state.updated_at
  ).run();

  return mssResult;
}

// ── Phase D++ — NSE Indicator alert delivery (shared by TDI + SMA) ──
// Unlike EBP/Sweep/MSS, nse_indicator_configs has no alert_mode column —
// every enabled config fires directly on its own internal conditions, no
// HTF-bias-alignment gate. Still respects nse_tf_access (admin-controlled)
// and requires a verified Telegram chat_id, same as every other NSE alert.
async function deliverNseIndicatorAlert(env, { userId, symbol, timeframe, direction, candleTime, alertType, message }) {
  const userRow = await env.DB.prepare('SELECT nse_tf_access FROM users WHERE id = ?').bind(userId).first();
  const tfAccess = JSON.parse(userRow?.nse_tf_access || '["M1","M5","M15","M30","1H","D"]');
  if (!tfAccess.includes(timeframe)) return;

  const tg = await env.DB.prepare(
    'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
  ).bind(userId).first();
  if (!tg?.chat_id) return;

  await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, message);

  await env.DB.prepare(`
    INSERT INTO alert_history
    (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    crypto.randomUUID(), userId, symbol, timeframe, direction, null, candleTime, Date.now(), alertType
  ).run();
}

// ── Phase D++ — TDI (Traders Dynamic Index) ─────────────────────

// Divergence check with nse_swing_states fallback. direction: 'bullish'
// checks for a bullish (higher-low) divergence against a bearish run;
// 'bearish' checks the mirror. Primary reference is the ongoing run's
// pending (not-yet-confirmed) extreme; if that's unavailable, falls back
// to a 20-candle lookback extreme close as a proxy swing reference (spec's
// wording mixes run_extreme/confirmed_swing_low terminology here — this is
// the most internally-consistent reading: use the live run's extreme when
// present, else approximate with the lookback).
function checkTdiDivergence(direction, candles, rsiSeries, swingState) {
  const priceKey    = direction === 'bullish' ? 'low' : 'high';
  const runDirNeeded = direction === 'bullish' ? 'bearish' : 'bullish';

  let refIdx = -1;
  let refPrice = null;

  if (swingState?.run_dir === runDirNeeded) {
    const extreme     = runDirNeeded === 'bearish' ? swingState.pending_swing_low : swingState.pending_swing_high;
    const extremeTime = runDirNeeded === 'bearish' ? swingState.pending_swing_low_time : swingState.pending_swing_high_time;
    if (extreme != null && extremeTime != null) {
      const extremeMs = new Date(extremeTime).getTime();
      refIdx = candles.findIndex(c => c.time === extremeMs);
      refPrice = extreme;
    }
  }

  if (refIdx < 0 || refIdx >= rsiSeries.length) {
    const lookback = candles.slice(0, Math.min(20, candles.length));
    let bestIdx = -1, bestClose = null;
    for (let i = 0; i < lookback.length; i++) {
      const c = lookback[i].close;
      const better = direction === 'bullish' ? (bestClose === null || c < bestClose) : (bestClose === null || c > bestClose);
      if (better) { bestClose = c; bestIdx = i; }
    }
    if (bestIdx < 0 || bestIdx >= rsiSeries.length) return false;
    refIdx   = bestIdx;
    refPrice = lookback[bestIdx][priceKey];
  }

  const refRsi  = rsiSeries[refIdx];
  const currRsi = rsiSeries[0];
  const currPrice = candles[0][priceKey];
  if (refRsi == null || currRsi == null || refPrice == null) return false;

  return direction === 'bullish'
    ? (currRsi > refRsi && currPrice <= refPrice)
    : (currRsi < refRsi && currPrice >= refPrice);
}

// Condition 4 — MSS confirmed (price beyond the confirmed swing level) +
// volume gate (equity only; skipped for index symbols).
function checkTdiCondition4(direction, candles, swingState, isIndex) {
  if (!swingState) return false;
  const priceOk = direction === 'bullish'
    ? (swingState.last_confirmed_swing_high != null && candles[0].close > swingState.last_confirmed_swing_high)
    : (swingState.last_confirmed_swing_low  != null && candles[0].close < swingState.last_confirmed_swing_low);
  if (!priceOk) return false;
  if (isIndex) return true;

  if (candles.length < 20) return false;
  const volSeries = candles.slice(0, 20).map(c => c.volume ?? 0);
  const avgVol = volSeries.reduce((a, b) => a + b, 0) / volSeries.length;
  const currVol = candles[0].volume ?? 0;
  return avgVol > 0 && currVol > avgVol * 1.5;
}

function buildTdiSmaContextLine(smaState, tdiDirection) {
  if (!smaState) return null; // omitted entirely — no nse_sma_state row for this asset
  if (smaState.phase === 'distribution') {
    const dirLabel = smaState.direction === 'bullish' ? 'Bullish markup' : 'Bearish distribution';
    const aligned  = smaState.direction === tdiDirection;
    return `📊 SMA Context: ${dirLabel} ${aligned ? '— aligned ✅' : 'active ⚠️'}`;
  }
  return `📊 SMA Context: Accumulation phase`;
}

function formatTdiAlert({ symbol, timeframe, direction, candleTime, mssLevel, volumeRatio, smaContextLine, isIndex }) {
  const emoji     = direction === 'bullish' ? '🟢' : '🔴';
  const label     = direction === 'bullish' ? 'BUY' : 'SELL';
  const bandLabel = direction === 'bullish' ? 'RSI exhaustion at lower band' : 'RSI exhaustion at upper band';
  const divLabel  = direction === 'bullish' ? 'Divergence: Price LL, RSI HL confirmed' : 'Divergence: Price HH, RSI LH confirmed';
  const momLabel  = direction === 'bullish' ? 'Momentum: Red crossed Yellow ↑' : 'Momentum: Red crossed Yellow ↓';
  const mssLabel  = direction === 'bullish' ? 'Swing high reclaimed' : 'Swing low broken';

  const lines = [
    `${emoji} <b>${label} — ${symbol}</b>`,
    `⏱ Timeframe: ${timeframe}`,
    `🕐 Candle: ${fmtIST(candleTime)} IST`,
    `━━━━━━━━━━━━━━`,
    `TDI: ${bandLabel}`,
    divLabel,
    momLabel,
    `MSS: ${mssLabel}: ${mssLevel?.toFixed(2)}`,
  ];
  if (!isIndex && volumeRatio != null) lines.push(`📦 Volume: ${volumeRatio.toFixed(1)}× average`);
  if (smaContextLine) lines.push(smaContextLine);
  lines.push(`━━━━━━━━━━━━━━`, `EBP Tracker`);
  return lines.join('\n');
}

// Main TDI entry point — called once per (user, asset, timeframe) with
// already-fetched candles (newest-first, from nse_indicator_candle_cache).
// updateSwingState() must already have run for this symbol/timeframe this
// cron cycle (enforced by the caller in handleNseCron), since this reads
// nse_swing_states directly rather than taking it as a parameter.
async function runTDIForAsset(symbol, timeframe, userId, assetId, candles, env) {
  if (!candles || candles.length < 48) return; // need enough history for RSI(13) + BB(34)

  const isIndex = isNseIndexSymbol(symbol);

  const rsiSeries = computeRSI(candles, 13); // newest-first, aligned with candles[i]
  if (rsiSeries.length < 35) return; // BB(34) needs 34 RSI values plus 1 for "prev"

  const rsiOldestFirst    = [...rsiSeries].reverse();
  const redOldestFirst    = computeSMA(rsiOldestFirst, 2);
  const yellowOldestFirst = computeSMA(rsiOldestFirst, 7);
  const bb                = computeBB(rsiOldestFirst, 34, 1.6185);

  const n = rsiOldestFirst.length;
  const toNewestIdx = (k) => n - 1 - k; // k=0 => newest, aligned with candles[k]

  const redNow     = redOldestFirst[toNewestIdx(0)];
  const redPrev    = redOldestFirst[toNewestIdx(1)];
  const yellowNow  = yellowOldestFirst[toNewestIdx(0)];
  const yellowPrev = yellowOldestFirst[toNewestIdx(1)];
  const bbUpperNow = bb.upper[toNewestIdx(0)];
  const bbLowerNow = bb.lower[toNewestIdx(0)];

  if ([redNow, redPrev, yellowNow, yellowPrev, bbUpperNow, bbLowerNow].some(v => v == null)) return;

  const swingState = await env.DB.prepare(
    'SELECT * FROM nse_swing_states WHERE symbol = ? AND tf = ?'
  ).bind(symbol, timeframe).first();

  const cond1Bull = redNow <= bbLowerNow;
  const cond1Bear = redNow >= bbUpperNow;
  const cond3Bull = redPrev <= yellowPrev && redNow > yellowNow;
  const cond3Bear = redPrev >= yellowPrev && redNow < yellowNow;
  const cond2Bull = checkTdiDivergence('bullish', candles, rsiSeries, swingState);
  const cond2Bear = checkTdiDivergence('bearish', candles, rsiSeries, swingState);

  const setupBull = cond1Bull && cond2Bull && cond3Bull;
  const setupBear = cond1Bear && cond2Bear && cond3Bear;

  const existingChain = await env.DB.prepare(
    'SELECT * FROM nse_indicator_chain WHERE user_id = ? AND asset_id = ? AND timeframe = ?'
  ).bind(userId, assetId, timeframe).first();

  const tfMinutes = { M15: 15, M30: 30 }[timeframe] ?? 15;
  const expiryMs  = tfMinutes * 60 * 1000 * 4; // 4 candles
  const now       = Date.now();

  // New setup (re)fires — create or overwrite the chain row, resetting
  // expiry, per spec: "overwrite the existing row (reset expiry)".
  if (setupBull || setupBear) {
    const direction = setupBull ? 'bullish' : 'bearish';
    const chainId = existingChain?.id ?? crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO nse_indicator_chain (id, user_id, asset_id, symbol, timeframe, direction, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        direction = excluded.direction, state = 1,
        created_at = excluded.created_at, expires_at = excluded.expires_at
    `).bind(chainId, userId, assetId, symbol, timeframe, direction, now, now + expiryMs).run();
    return;
  }

  if (!existingChain) return; // State 0 — nothing pending

  if (existingChain.expires_at <= now) {
    await env.DB.prepare('DELETE FROM nse_indicator_chain WHERE id = ?').bind(existingChain.id).run();
    return;
  }

  // State 1 — check condition 4 (MSS + volume)
  const cond4 = checkTdiCondition4(existingChain.direction, candles, swingState, isIndex);
  if (!cond4) return;

  await env.DB.prepare('DELETE FROM nse_indicator_chain WHERE id = ?').bind(existingChain.id).run();

  const direction = existingChain.direction;
  const mssLevel  = direction === 'bullish' ? swingState.last_confirmed_swing_high : swingState.last_confirmed_swing_low;

  let volumeRatio = null;
  if (!isIndex && candles.length >= 20) {
    const volSeries = candles.slice(0, 20).map(c => c.volume ?? 0);
    const avgVol = volSeries.reduce((a, b) => a + b, 0) / volSeries.length;
    volumeRatio = avgVol > 0 ? (candles[0].volume ?? 0) / avgVol : null;
  }

  const smaState = await env.DB.prepare(
    'SELECT phase, direction FROM nse_sma_state WHERE symbol = ? AND timeframe = ?'
  ).bind(symbol, timeframe).first();
  const smaContextLine = buildTdiSmaContextLine(smaState, direction);

  const message = formatTdiAlert({
    symbol, timeframe, direction, candleTime: candles[0].time,
    mssLevel, volumeRatio, smaContextLine, isIndex,
  });

  await deliverNseIndicatorAlert(env, {
    userId, symbol, timeframe, direction,
    candleTime: candles[0].time, alertType: 'tdi', message,
  });
}

// ── Phase D++ — SMA Cloud (corrective patch) ────────────────────
// Cloud = gap between SMA1 (close price) and SMA9 (9-period SMA of close),
// both on the NATIVE timeframe. HTF SMA9 (user-configurable M30/1H) is a
// bias reference only — it is no longer part of the cloud, so it needs no
// alignment onto the LTF candle timeline (that machinery is gone).

// candles: newest-first. SMA1 is simply the close price.
function computeSMA1(candles) {
  return candles.map(c => c.close);
}

// candles: newest-first. Thin wrapper around the shared computeSMA(values,
// period) primitive (reverse→compute→reverse) — the same helper TDI's
// red/yellow lines use — rather than a second parallel SMA implementation.
function computeSMA9(candles) {
  const closesOldestFirst = [...candles].reverse().map(c => c.close);
  const sma9OldestFirst   = computeSMA(closesOldestFirst, 9);
  return [...sma9OldestFirst].reverse();
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

// Which side of BOTH SMA1 and SMA9 a candle closed on. null = ambiguous
// (inside cloud, or a value missing) — used to bootstrap the candidate
// direction (3 consecutive candles agreeing) and to count same-side runs.
function sma1x9CandleSide(candles, sma1Arr, sma9Arr, i) {
  if (sma1Arr[i] == null || sma9Arr[i] == null) return null;
  const c = candles[i].close;
  if (c > sma1Arr[i] && c > sma9Arr[i]) return 'bullish';
  if (c < sma1Arr[i] && c < sma9Arr[i]) return 'bearish';
  return null;
}

function priceSameSide(candles, sma1Arr, sma9Arr, direction, count) {
  let consistent = 0;
  for (let i = 0; i < count; i++) {
    const c = candles[i].close;
    if (direction === 'bearish' && c < sma1Arr[i] && c < sma9Arr[i]) consistent++;
    if (direction === 'bullish' && c > sma1Arr[i] && c > sma9Arr[i]) consistent++;
  }
  return consistent;
}

function checkStack(currentSMA1, currentSMA9, close, stackMode) {
  if (stackMode === 'strict') {
    const bullish = currentSMA1 > currentSMA9 && close > currentSMA1;
    const bearish = currentSMA1 < currentSMA9 && close < currentSMA1;
    return { bullish, bearish };
  }
  const bullish = close > currentSMA9;
  const bearish = close < currentSMA9;
  return { bullish, bearish };
}

function checkSmaCooldown(timeframe, smaState) {
  if (timeframe === 'M15') {
    const nowIstDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // 'YYYY-MM-DD'
    return !smaState?.last_signal_date || smaState.last_signal_date < nowIstDate;
  }
  // M5 — 12-candle (1 hour) cooldown
  if (!smaState?.last_signal_time) return true;
  return (Date.now() - smaState.last_signal_time) > 60 * 60 * 1000;
}

// Dual-mode bias gate. 'htf_sma': close vs SMA9 on the user-chosen HTF
// (M30/1H). 'ttrades': bias_cache row for that same HTF, TTrades-derived.
async function checkSMABias(symbol, htfTimeframe, biasMode, htfCandles, direction, env) {
  if (biasMode === 'htf_sma') {
    const smaHTFValue = computeSMAHTF(htfCandles);
    if (smaHTFValue === null) return { passes: false, label: 'HTF SMA unavailable' };
    const currentClose = htfCandles[0].close;
    const bullish = currentClose > smaHTFValue;
    const bearish = currentClose < smaHTFValue;
    const passes = direction === 'bullish' ? bullish : bearish;
    return { passes, label: `HTF SMA ${htfTimeframe}` };
  }
  const row = await env.DB.prepare(
    'SELECT bias FROM bias_cache WHERE symbol = ? AND timeframe = ?'
  ).bind(symbol, htfTimeframe).first();
  if (!row) return { passes: false, label: 'TTrades bias unavailable' };
  const passes = row.bias === direction;
  return { passes, label: `TTrades ${htfTimeframe}` };
}

// 50% candle-strength rule — replaces the old TTrades-closure check for
// Type 2 rejection confirmation. pct is normalised so a HIGHER number
// always means a stronger rejection in the signal's direction, in both
// directions (the literal spec formula had pct inverted — a maximally
// bearish candle, closePosition≈0, would have shown "0% — strong"; this
// flips it so "95% — strong" reads as strong in either direction).
function checkCandleStrength(candle, direction) {
  const range = candle.high - candle.low;
  if (range === 0) return { passes: false, closePosition: 0.5, pct: 50 };

  const closePosition = (candle.close - candle.low) / range;

  // Bearish rejection: close in bottom 50% of range.
  // Bullish rejection: close in top 50% of range.
  const passes = direction === 'bearish'
    ? closePosition < 0.50
    : closePosition >= 0.50;

  const pct = direction === 'bearish'
    ? Math.round((1 - closePosition) * 100)  // close near candle low → high pct
    : Math.round(closePosition * 100);       // close near candle high → high pct

  return { passes, closePosition, pct };
}

// Phase state machine — pure transition function. prev: prior nse_sma_state
// row (or null). m: computed metrics for this run. Returns the new
// phase/direction/consecutive_widening plus edge-transition flags used to
// gate Type 1 and the exhaustion notification.
//
// ATR-relative thresholds (atr14 * 0.15 / 0.03) make the four phase
// conditions self-calibrating across differently-priced assets — this is a
// genuine behaviour change from the deployed version (which had no
// ATR-gated phase transitions), grafted into the same prevPhase-branching
// skeleton:
//   - ACCUMULATION condition guards the accumulation→transition edge (noise
//     filter: too many recent crossovers, or the gap is negligible vs ATR).
//   - TRANSITION condition arms a candidate direction (same role as before).
//   - DISTRIBUTION ACTIVE condition confirms the transition→distribution
//     edge, replacing the old fixed 2-bar hysteresis counter.
//   - EXHAUSTION condition confirms the distribution→accumulation edge,
//     replacing the old "narrowing vs 5-bars-ago" relative check.
function advanceSmaPhase(prev, m) {
  const prevPhase = prev?.phase ?? 'accumulation';
  let phase = prevPhase;
  let direction = prev?.direction ?? null;
  let consecutiveWidening = prev?.consecutive_widening ?? 0;
  let justEnteredDistribution = false;
  let justExhausted = false;

  const stillAccumulating = m.crossover20 >= 3 || m.separationNow < (m.atr14 * 0.15);
  const transitionCondition = m.crossover5 === 0 && m.widening && m.sameSide3 === 3;
  const armedCandidate = transitionCondition ? m.candidateDirection3 : null;
  const distributionActive = m.crossover10 === 0 && m.separationNow > (m.atr14 * 0.15) && m.sameSide5 >= 4;
  const exhaustionCondition = m.separationNow < (m.atr14 * 0.15) && m.crossover5 >= 1 && m.sameSide5 <= 3;

  if (prevPhase === 'accumulation') {
    if (!stillAccumulating && armedCandidate) {
      phase = 'transition'; direction = armedCandidate; consecutiveWidening = 1;
    } else {
      phase = 'accumulation'; direction = null; consecutiveWidening = 0;
    }
  } else if (prevPhase === 'transition') {
    const stillArmed = armedCandidate === direction;
    if (stillArmed) {
      consecutiveWidening += 1;
      if (distributionActive) { phase = 'distribution'; justEnteredDistribution = true; }
    } else if (armedCandidate) {
      phase = 'transition'; direction = armedCandidate; consecutiveWidening = 1;
    } else {
      phase = 'accumulation'; direction = null; consecutiveWidening = 0;
    }
  } else if (prevPhase === 'distribution') {
    if (exhaustionCondition) {
      phase = 'accumulation'; justExhausted = true;
    } else {
      phase = 'distribution';
    }
  }

  return { phase, direction, consecutiveWidening, justEnteredDistribution, justExhausted };
}

function formatSmaType1Alert({ symbol, timeframe, direction, candleTime, velocityLabel, sma1Val, sma9Val, smaHTFVal, htfTimeframe, biasLabel, volumeRatio, isIndex }) {
  const emoji        = direction === 'bullish' ? '🟢' : '🔴';
  const label         = direction === 'bullish' ? 'BUY' : 'SELL';
  const trendLabel    = direction === 'bullish' ? 'Bullish markup' : 'Bearish distribution';
  const velocityIcon  = velocityLabel === 'Sharp' ? '⚡' : '📉';

  const lines = [
    `${emoji} <b>${label} — ${symbol}</b>`,
    `⏱ Timeframe: ${timeframe}`,
    `🕐 Candle: ${fmtIST(candleTime)} IST`,
    `━━━━━━━━━━━━━━`,
    `SMA Cloud: ${trendLabel} — ${velocityLabel} ${velocityIcon}`,
    `SMA 1: ${sma1Val?.toFixed(2)}`,
    `SMA 9 (${timeframe}): ${sma9Val?.toFixed(2)}`,
    `HTF SMA 9 (${htfTimeframe}): ${smaHTFVal !== null ? smaHTFVal.toFixed(2) : 'N/A'}`,
    `Bias: ${direction === 'bullish' ? 'Bullish' : 'Bearish'} (${biasLabel}) ✅`,
  ];
  if (!isIndex && volumeRatio != null) lines.push(`📦 Volume: ${volumeRatio.toFixed(1)}× average`);
  lines.push(`━━━━━━━━━━━━━━`, `EBP Tracker`);
  return lines.join('\n');
}

function formatSmaType2Alert({ symbol, timeframe, direction, candleTime, cloudBoundary, htfTimeframe, biasLabel, closePct }) {
  const emoji        = direction === 'bullish' ? '🟢' : '🔴';
  const label        = direction === 'bullish' ? 'BUY' : 'SELL';
  const boundaryLabel = direction === 'bearish' ? 'cloud top' : 'cloud bottom';

  return [
    `${emoji} <b>${label} — ${symbol}</b>`,
    `⏱ Timeframe: ${timeframe}`,
    `🕐 Candle: ${fmtIST(candleTime)} IST`,
    `━━━━━━━━━━━━━━`,
    `SMA Cloud: ${direction === 'bullish' ? 'Bullish' : 'Bearish'} re-entry`,
    `Rejected from ${boundaryLabel}: ${cloudBoundary?.toFixed(2)}`,
    `Close strength: ${closePct}% — strong ✅`,
    `Bias: ${direction === 'bullish' ? 'Bullish' : 'Bearish'} (${biasLabel}) ✅`,
    `━━━━━━━━━━━━━━`,
    `EBP Tracker`,
  ].join('\n');
}

function formatSmaExhaustionAlert({ symbol, timeframe, candleTime }) {
  return [
    `⚠️ <b>${symbol} — SMA Trend Exhausting</b>`,
    `⏱ Timeframe: ${timeframe}`,
    `🕐 Candle: ${fmtIST(candleTime)} IST`,
    `━━━━━━━━━━━━━━`,
    `SMAs converging — distribution phase ending`,
    `Consider tightening stops or exiting position`,
    `━━━━━━━━━━━━━━`,
    `EBP Tracker`,
  ].join('\n');
}

// Main SMA Cloud entry point — called once per (user, asset, timeframe)
// with already-fetched native-TF candles and HTF candles (both
// newest-first; HTF timeframe is per-config, M30 or 1H). Reads/writes
// nse_sma_state every run regardless of whether a signal fires.
async function runSMAForAsset(symbol, timeframe, userId, assetId, candles, htfCandles, stackMode, biasMode, htfTimeframe, env) {
  if (!candles || candles.length < 25 || !htfCandles || htfCandles.length < 9) return;

  const isIndex = isNseIndexSymbol(symbol);
  const mode = stackMode === 'loose' ? 'loose' : 'strict';

  const sma1 = computeSMA1(candles); // newest-first, aligned with candles[i]
  const sma9 = computeSMA9(candles); // newest-first, aligned with candles[i]

  const atr14 = computeATR(candles, 14);
  if (sma1[0] == null || sma9[0] == null || atr14 == null) return;
  if (sma1.length < 21 || sma9.length < 21) return; // need 20-candle crossover window + 1

  const crossover20 = countSma1x9Crossovers(20, sma1, sma9);
  const crossover10 = countSma1x9Crossovers(10, sma1, sma9);
  const crossover5  = countSma1x9Crossovers(5,  sma1, sma9);

  const separationNow  = Math.abs(sma1[0] - sma9[0]);
  const separation5Ago = (sma1[5] != null && sma9[5] != null) ? Math.abs(sma1[5] - sma9[5]) : separationNow;
  const separationVelocity = (separationNow - separation5Ago) / 5;
  const velocityLabel = separationVelocity > (atr14 * 0.03) ? 'Sharp' : 'Gradual';
  const widening = separationNow > separation5Ago;

  const cloudTop    = Math.max(sma1[0], sma9[0]);
  const cloudBottom = Math.min(sma1[0], sma9[0]);

  const side0 = sma1x9CandleSide(candles, sma1, sma9, 0);
  const side1 = sma1x9CandleSide(candles, sma1, sma9, 1);
  const side2 = sma1x9CandleSide(candles, sma1, sma9, 2);
  const candidateDirection3 = (side0 && side0 === side1 && side1 === side2) ? side0 : null;
  const sameSide3 = candidateDirection3 ? priceSameSide(candles, sma1, sma9, candidateDirection3, 3) : 0;

  const priorState = await env.DB.prepare(
    'SELECT * FROM nse_sma_state WHERE symbol = ? AND timeframe = ?'
  ).bind(symbol, timeframe).first();

  // 5-candle consistency is evaluated against the ESTABLISHED direction
  // (continuity check during an ongoing transition/distribution run) —
  // falls back to the freshly-bootstrapped 3-candle candidate only when
  // there's no established direction yet (coming from accumulation).
  const sameSide5Direction = priorState?.direction ?? candidateDirection3 ?? null;
  const sameSide5 = sameSide5Direction ? priceSameSide(candles, sma1, sma9, sameSide5Direction, 5) : 0;

  const advance = advanceSmaPhase(priorState, {
    crossover20, crossover10, crossover5, separationNow, widening,
    sameSide3, sameSide5, candidateDirection3, atr14,
  });

  await env.DB.prepare(`
    INSERT INTO nse_sma_state (
      symbol, timeframe, direction, phase, stack_active, consecutive_widening,
      separation, velocity_label, atr14, cloud_top, cloud_bottom,
      stack_formed_date, last_signal_date, last_signal_time, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol, timeframe) DO UPDATE SET
      direction = excluded.direction, phase = excluded.phase,
      stack_active = excluded.stack_active, consecutive_widening = excluded.consecutive_widening,
      separation = excluded.separation, velocity_label = excluded.velocity_label,
      atr14 = excluded.atr14, cloud_top = excluded.cloud_top, cloud_bottom = excluded.cloud_bottom,
      stack_formed_date = excluded.stack_formed_date, updated_at = excluded.updated_at
  `).bind(
    symbol, timeframe, advance.direction, advance.phase,
    advance.phase === 'distribution' ? 1 : 0, advance.consecutiveWidening,
    separationNow, velocityLabel, atr14, cloudTop, cloudBottom,
    advance.justEnteredDistribution ? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : (priorState?.stack_formed_date ?? null),
    priorState?.last_signal_date ?? null, priorState?.last_signal_time ?? null,
    Date.now()
  ).run();

  // ── Exhaustion notification ──
  if (advance.justExhausted) {
    const message = formatSmaExhaustionAlert({ symbol, timeframe, candleTime: candles[0].time });
    await deliverNseIndicatorAlert(env, {
      userId, symbol, timeframe, direction: priorState?.direction ?? null,
      candleTime: candles[0].time, alertType: 'sma_exhaustion', message,
    });
    return; // exhaustion and a fresh Type1/Type2 can't both fire the same run
  }

  // ── Type 1 — trend initiation (fires exactly on the transition edge) ──
  if (advance.justEnteredDistribution) {
    const direction = advance.direction;
    const close = candles[0].close;
    const beyondCloud = direction === 'bullish' ? close > cloudTop : close < cloudBottom;
    const stack = checkStack(sma1[0], sma9[0], close, mode);
    const stackOk = direction === 'bullish' ? stack.bullish : stack.bearish;

    if (beyondCloud && stackOk) {
      const bias = await checkSMABias(symbol, htfTimeframe, biasMode, htfCandles, direction, env);
      if (bias.passes) {
        let volumeRatio = null;
        if (!isIndex) {
          if (candles.length < 20) return;
          const volSeries = candles.slice(0, 20).map(c => c.volume ?? 0);
          const avgVol = volSeries.reduce((a, b) => a + b, 0) / volSeries.length;
          volumeRatio = avgVol > 0 ? (candles[0].volume ?? 0) / avgVol : null;
          if (!(avgVol > 0 && (candles[0].volume ?? 0) > avgVol * 1.5)) return; // volume gate not met
        }

        const smaHTFVal = computeSMAHTF(htfCandles);
        const message = formatSmaType1Alert({
          symbol, timeframe, direction, candleTime: candles[0].time, velocityLabel,
          sma1Val: sma1[0], sma9Val: sma9[0], smaHTFVal, htfTimeframe,
          biasLabel: bias.label, volumeRatio, isIndex,
        });
        await deliverNseIndicatorAlert(env, {
          userId, symbol, timeframe, direction,
          candleTime: candles[0].time, alertType: 'sma_type1', message,
        });
        await env.DB.prepare(`
          UPDATE nse_sma_state SET last_signal_date = ?, last_signal_time = ? WHERE symbol = ? AND timeframe = ?
        `).bind(
          new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), Date.now(), symbol, timeframe
        ).run();
      }
    }
    return; // Type 1 and Type 2 don't both fire on the same run
  }

  // ── Type 2 — cloud rejection re-entry (subsequent sessions in distribution) ──
  if (advance.phase === 'distribution' && priorState?.phase === 'distribution') {
    const direction = advance.direction;
    if (!direction) return;
    if (!checkSmaCooldown(timeframe, priorState)) return;

    const bar0 = candles[0], bar1 = candles[1];
    if (!bar1) return;

    const entered  = direction === 'bearish' ? bar0.high >= cloudBottom : bar0.low <= cloudTop;
    const rejected = direction === 'bearish' ? bar0.close < cloudBottom : bar0.close > cloudTop;
    if (!entered || !rejected) return;

    const strength = checkCandleStrength(bar0, direction);
    if (!strength.passes) return;

    const bias = await checkSMABias(symbol, htfTimeframe, biasMode, htfCandles, direction, env);
    if (!bias.passes) return;

    const cloudBoundary = direction === 'bearish' ? cloudBottom : cloudTop;
    const message = formatSmaType2Alert({
      symbol, timeframe, direction, candleTime: bar0.time,
      cloudBoundary, htfTimeframe, biasLabel: bias.label, closePct: strength.pct,
    });
    await deliverNseIndicatorAlert(env, {
      userId, symbol, timeframe, direction,
      candleTime: bar0.time, alertType: 'sma_type2', message,
    });
    await env.DB.prepare(`
      UPDATE nse_sma_state SET last_signal_date = ?, last_signal_time = ? WHERE symbol = ? AND timeframe = ?
    `).bind(
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), Date.now(), symbol, timeframe
    ).run();
  }
}

// ── NSE candle cache ──────────────────────────────────────────
async function updateNseCandleCache(db, symbol, tf, candles) {
  const [b0, b1, b2] = candles;
  await db.prepare(`
    INSERT OR REPLACE INTO nse_candle_cache
    (symbol, timeframe,
     bar_0_open, bar_0_high, bar_0_low, bar_0_close,
     bar_1_open, bar_1_high, bar_1_low, bar_1_close,
     bar_2_open, bar_2_high, bar_2_low, bar_2_close,
     bar_0_time, bar_1_time, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    symbol, tf,
    b0?.open ?? null, b0?.high ?? null, b0?.low ?? null, b0?.close ?? null,
    b1?.open ?? null, b1?.high ?? null, b1?.low ?? null, b1?.close ?? null,
    b2?.open ?? null, b2?.high ?? null, b2?.low ?? null, b2?.close ?? null,
    b0?.time ?? null, b1?.time ?? null, Date.now()
  ).run();
}

// ── Telegram ──────────────────────────────────────────────────
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

function fmtIST(ts) {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'Asia/Kolkata',
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// ── Phase I addendum — trading session at signal fire time ─────
// Same NY-clock-relative buckets as the EBP/Sweep Workers, applied here
// unchanged — this labels which global FX session was active when the
// signal fired, not whether the NSE market itself was open.
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

function formatNseEBPAlert({ symbol, tf, direction, candleTime, trendBias, biasTF, sweptLevel, closedLevel, signalId }) {
  const emoji     = direction === 'bullish' ? '🟢' : '🔴';
  const label     = direction === 'bullish' ? 'BULLISH EBP' : 'BEARISH EBP';
  const swept     = direction === 'bullish' ? 'Low swept' : 'High swept';
  const closed    = direction === 'bullish' ? 'Closed above body' : 'Closed below body';
  const alignMark = direction === trendBias ? '✅' : (trendBias === 'neutral' ? '' : '⚠️ No Trend Filter');
  return `${emoji} <b>${label} — ${symbol}</b>
⏱ Timeframe: ${tf}
🕐 Candle: ${fmtIST(candleTime)} IST
📊 Trend: ${trendBias}${biasTF ? ` (${biasTF} bias)` : ''} ${alignMark}
━━━━━━━━━━━━━━
${swept}: ${sweptLevel}
${closed}: ${closedLevel}
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}
EBP Tracker`;
}

function formatNseSweepAlert({ symbol, tf, direction, candleTime, trendBias, biasTF, sweptLevel, closedInsideLevel, signalId }) {
  const emoji     = direction === 'bullish' ? '🟢' : '🔴';
  const label     = direction === 'bullish' ? 'BULLISH SWEEP' : 'BEARISH SWEEP';
  const swept     = direction === 'bullish' ? 'Low swept' : 'High swept';
  const alignMark = direction === trendBias ? '✅' : (trendBias === 'neutral' ? '' : '⚠️ No Trend Filter');
  return `${emoji} <b>${label} — ${symbol}</b>
⏱ Timeframe: ${tf}
🕐 Candle: ${fmtIST(candleTime)} IST
📊 Trend: ${trendBias}${biasTF ? ` (${biasTF} bias)` : ''} ${alignMark}
━━━━━━━━━━━━━━
${swept}: ${sweptLevel}
Closed inside: ${closedInsideLevel}
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}
EBP Tracker`;
}

function formatNseMSSAlert({ symbol, tf, mss, trendBias, biasTF, signalId }) {
  const emoji      = mss.direction === 'bullish' ? '🟢' : '🔴';
  const label      = mss.direction === 'bullish' ? 'BULLISH MSS' : 'BEARISH MSS';
  const swingLabel = mss.direction === 'bullish' ? 'Swing high reclaimed' : 'Swing low reclaimed';
  const alignMark  = mss.direction === trendBias ? '✅' : (trendBias === 'neutral' ? '' : '⚠️ No Trend Filter');
  return `${emoji} <b>${label} — ${symbol}</b>
⏱ Timeframe: ${tf}
🕐 Candle: ${fmtIST(mss.candle_time)} IST
📊 Trend: ${trendBias}${biasTF ? ` (${biasTF} bias)` : ''} ${alignMark}
━━━━━━━━━━━━━━
${swingLabel}: ${mss.level?.toFixed(2)}
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}
EBP Tracker`;
}

// ── Per-user alert delivery ───────────────────────────────────
// Gates on nse_tf_access (NOT user_tf_access — that column is
// forex/crypto only, per the Phase A decision) and alert_mode,
// then looks up the user's verified Telegram chat_id at fire time
// — same pattern as handleEBPCron/handleSweepCron.
async function tryDeliverNseAlert(env, row, { symbol, tf, alertType, direction, effectiveBias, candleTime, message }) {
  const nseTfAccess = JSON.parse(row.nse_tf_access || '["M1","M5","M15","M30","1H","D"]');
  if (!nseTfAccess.includes(tf)) return;

  const alertMode = row.alert_mode ?? 'aligned';
  if (alertMode === 'aligned' && direction !== effectiveBias) return;

  const tg = await env.DB.prepare(
    'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
  ).bind(row.user_id).first();
  if (!tg?.chat_id) return;

  await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, message);

  await env.DB.prepare(`
    INSERT INTO alert_history
    (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    crypto.randomUUID(), row.user_id, symbol, tf,
    direction, effectiveBias, candleTime, Date.now(), alertType
  ).run();
}

// ── Main cron handler ─────────────────────────────────────────
export async function handleNseCron(env, tf) {
  if (!isNseMarketOpen()) {
    return { ok: true, skipped: 'market closed' };
  }
  if (!NSE_VALID_TFS.includes(tf)) {
    return { ok: false, error: `Invalid TF: ${tf}` };
  }

  if (tf === 'M1') {
    await cleanupExpiredNseFVGs(env.DB);
  }

  // Two separate config-type queries — same proven pattern as
  // handleEBPCron/handleSweepCron — rather than the UNION originally
  // proposed, which dropped symbol/alert_mode and never joined
  // user_telegram at all.
  const { results: ebpRows } = await env.DB.prepare(`
    SELECT ec.id as config_id, ec.alert_mode,
           ua.id as asset_id, ua.symbol,
           u.id as user_id, u.nse_tf_access
    FROM user_ebp_configs ec
    JOIN user_assets ua ON ec.asset_id = ua.id
    JOIN users u ON ec.user_id = u.id
    WHERE ua.asset_type='nse' AND ec.timeframe=? AND ec.enabled=1
    AND u.active=1
  `).bind(tf).all();

  const { results: sweepRows } = await env.DB.prepare(`
    SELECT sc.id as config_id, sc.alert_mode,
           ua.id as asset_id, ua.symbol,
           u.id as user_id, u.nse_tf_access
    FROM user_sweep_configs sc
    JOIN user_assets ua ON sc.asset_id = ua.id
    JOIN users u ON sc.user_id = u.id
    WHERE ua.asset_type='nse' AND sc.timeframe=? AND sc.enabled=1
    AND u.active=1
  `).bind(tf).all();

  // Phase D++ — TDI / SMA Cloud configs (same two-query-pattern reasoning
  // as ebp/sweep above — no UNION, joins user_telegram at fire time instead).
  const { results: indicatorRows } = await env.DB.prepare(`
    SELECT ic.id as config_id, ic.indicator, ic.stack_mode, ic.enabled,
           ic.bias_mode, ic.htf_timeframe,
           ua.id as asset_id, ua.symbol,
           u.id as user_id
    FROM nse_indicator_configs ic
    JOIN user_assets ua ON ic.asset_id = ua.id
    JOIN users u ON ic.user_id = u.id
    WHERE ua.asset_type='nse' AND ic.timeframe=? AND ic.enabled=1
    AND u.active=1
  `).bind(tf).all();

  const symbolMap = new Map(); // symbol -> { ebp: [rows], sweep: [rows], indicators: [rows] }
  for (const row of (ebpRows ?? [])) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, { ebp: [], sweep: [], indicators: [] });
    symbolMap.get(row.symbol).ebp.push(row);
  }
  for (const row of (sweepRows ?? [])) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, { ebp: [], sweep: [], indicators: [] });
    symbolMap.get(row.symbol).sweep.push(row);
  }
  for (const row of (indicatorRows ?? [])) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, { ebp: [], sweep: [], indicators: [] });
    symbolMap.get(row.symbol).indicators.push(row);
  }

  if (symbolMap.size === 0) {
    return { ok: true, symbolsProcessed: 0 };
  }

  const biasTF = NSE_BIAS_SOURCE.ebp[tf] ?? null; // identical map for ebp/sweep per spec

  for (const [symbol, { ebp: ebpUserRows, sweep: sweepUserRows, indicators: indicatorConfigRows }] of symbolMap) {
    try {
      const candles = await fetchNseCandles(symbol, tf, env);
      if (!candles || candles.length < 2) continue;

      let htfBias = 'neutral';
      if (biasTF) {
        const htfCandles = await fetchNseCandles(symbol, biasTF, env);
        if (htfCandles?.length >= 2) {
          const biasResult = calcTTradesBias({ bar1: htfCandles[0], bar2: htfCandles[1] });
          biasResult.bar1Time = htfCandles[0].time;
          htfBias = biasResult.bias;
          await writeBiasCache(env.DB, symbol, biasTF, biasResult);
        }
      }

      await updateNseCandleCache(env.DB, symbol, tf, candles);

      let mssResult = null;
      if (candles.length >= 3) {
        const oldestFirst = [candles[2], candles[1], candles[0]];
        // FVG detection (Phase 1) — NSE TFs M5/M15/1H only.
        if (['M5', 'M15', '1H'].includes(tf)) {
          await processFVGZones(env.DB, symbol, tf, oldestFirst, candles[0]);
        }
        mssResult = await updateSwingState(env.DB, symbol, tf, oldestFirst);
      }

      const ebpResult   = detectEBP(candles);
      const sweepResult = detectSweep(candles);

      if (mssResult) {
        const signalId = await generateNseSignalId(env, symbol);
        const firedAt  = new Date().toISOString();
        // detectMSS() returns {direction, level, candle_time} — no close field —
        // so price_at_signal comes from candles[0] (newest candle), not mssResult.
        await env.DB.prepare(`
          INSERT INTO signals (
            signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at, traded,
            price_at_signal, htf_bias, session, htf_close
          )
          VALUES (?,?,?,?,?,?,?,0,?,?,?,?)
        `).bind(
          signalId, 'NSE_MSS', symbol, biasTF, tf, mssResult.direction, firedAt,
          candles[0].close ?? null, htfBias ?? null, deriveSession(firedAt), null
        ).run();

        const message = formatNseMSSAlert({ symbol, tf, mss: mssResult, trendBias: htfBias, biasTF, signalId });
        const seen = new Set();
        for (const row of [...ebpUserRows, ...sweepUserRows]) {
          if (seen.has(row.user_id)) continue;
          seen.add(row.user_id);
          await tryDeliverNseAlert(env, row, {
            symbol, tf, alertType: 'mss', direction: mssResult.direction,
            effectiveBias: htfBias, candleTime: mssResult.candle_time, message,
          });
        }
      }

      if (ebpResult && ebpUserRows.length) {
        const signalId = await generateNseSignalId(env, symbol);
        const firedAt  = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO signals (
            signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at, traded,
            price_at_signal, htf_bias, session, htf_close
          )
          VALUES (?,?,?,?,?,?,?,0,?,?,?,?)
        `).bind(
          signalId, 'NSE_EBP', symbol, biasTF, tf, ebpResult.direction, firedAt,
          ebpResult.closedLevel ?? null, htfBias ?? null, deriveSession(firedAt), null
        ).run();

        const message = formatNseEBPAlert({
          symbol, tf, direction: ebpResult.direction, candleTime: ebpResult.candleTime,
          trendBias: htfBias, biasTF,
          sweptLevel: ebpResult.sweptLevel?.toFixed(2), closedLevel: ebpResult.closedLevel?.toFixed(2),
          signalId,
        });
        for (const row of ebpUserRows) {
          await tryDeliverNseAlert(env, row, {
            symbol, tf, alertType: 'ebp', direction: ebpResult.direction,
            effectiveBias: htfBias, candleTime: ebpResult.candleTime, message,
          });
        }
      }

      if (sweepResult && sweepUserRows.length) {
        const signalId = await generateNseSignalId(env, symbol);
        const firedAt  = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO signals (
            signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at, traded,
            price_at_signal, htf_bias, session, htf_close
          )
          VALUES (?,?,?,?,?,?,?,0,?,?,?,?)
        `).bind(
          signalId, 'NSE_SWEEP', symbol, biasTF, tf, sweepResult.direction, firedAt,
          sweepResult.closedInsideLevel ?? null, htfBias ?? null, deriveSession(firedAt), null
        ).run();

        const message = formatNseSweepAlert({
          symbol, tf, direction: sweepResult.direction, candleTime: sweepResult.candleTime,
          trendBias: htfBias, biasTF,
          sweptLevel: sweepResult.sweptLevel?.toFixed(2), closedInsideLevel: sweepResult.closedInsideLevel?.toFixed(2),
          signalId,
        });
        for (const row of sweepUserRows) {
          await tryDeliverNseAlert(env, row, {
            symbol, tf, alertType: 'sweep', direction: sweepResult.direction,
            effectiveBias: htfBias, candleTime: sweepResult.candleTime, message,
          });
        }
      }

      // ── Phase D++ — TDI / SMA Cloud indicators ──
      // updateSwingState() already ran above (before this block) — required
      // since TDI reads nse_swing_states directly. Reuses `candles` (already
      // fetched above) via mergeAndCacheNSECandles rather than fetching
      // again — one Upstox call per symbol+TF per run regardless of how
      // many indicators/users are configured on this asset.
      if (indicatorConfigRows.length > 0) {
        const indicatorCandles = await mergeAndCacheNSECandles(symbol, tf, candles, env);
        if (indicatorCandles && indicatorCandles.length > 0) {
          // Per-user htf_timeframe (M30 or 1H) means different SMA configs on
          // the same symbol+TF can want different HTF legs — cache by
          // htf_timeframe rather than a single variable, so it's still at
          // most one Upstox/Yahoo call per distinct HTF actually requested.
          const htfCandlesCache = new Map();
          for (const cfg of indicatorConfigRows) {
            try {
              if (cfg.indicator === 'tdi') {
                await runTDIForAsset(symbol, tf, cfg.user_id, cfg.asset_id, indicatorCandles, env);
              } else if (cfg.indicator === 'sma') {
                const htfTimeframe = cfg.htf_timeframe ?? '1H';
                if (!htfCandlesCache.has(htfTimeframe)) {
                  htfCandlesCache.set(htfTimeframe, await fetchHTFCandles(symbol, htfTimeframe, env));
                }
                const htfCandlesForSma = htfCandlesCache.get(htfTimeframe);
                if (htfCandlesForSma) {
                  await runSMAForAsset(
                    symbol, tf, cfg.user_id, cfg.asset_id, indicatorCandles, htfCandlesForSma,
                    cfg.stack_mode, cfg.bias_mode ?? 'ttrades', htfTimeframe, env
                  );
                }
              }
            } catch (err) {
              console.error(`[NSE-IND] ${cfg.indicator} error ${symbol} ${tf} user=${cfg.user_id}: ${err.message}`);
            }
          }
        }
      }

      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[NSE] cron error ${symbol} ${tf}: ${err.message}`);
    }
  }

  return { ok: true, symbolsProcessed: symbolMap.size };
}
