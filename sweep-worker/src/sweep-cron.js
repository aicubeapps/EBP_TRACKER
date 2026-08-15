// ============================================================
// Sweep Worker Cron Handler — Standalone (no external imports)
// All core functions inlined to avoid Wrangler bundling issues
// with cross-package relative imports.
// ============================================================

// ── TTrades Closure Bias (inlined, standalone) ──

function calcTTradesBias({ bar1, bar2 }) {
  const c0    = bar1.close;
  const h0    = bar1.high;
  const l0    = bar1.low;
  const prevH = bar2.high;
  const prevL = bar2.low;

  const sweptH   = h0 > prevH && c0 <= prevH;
  const sweptL   = l0 < prevL && c0 >= prevL;
  const insideD  = h0 <= prevH && l0 >= prevL;
  const outsideD = h0 > prevH  && l0 < prevL;
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
  sweep:    { 'M15': '1H', 'M30': '4H', '1H': 'D', '4H': 'W' },
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
// (user_templates and the EBP-worker asset-delete cascade are both
// asset_id-keyed), direction always 'bullish'/'bearish' (never 'bull'/
// 'bear' — matches every detector in this codebase).

async function insertChain(db, {
  templateType, userId, assetId, symbol, htf, ltf, direction, state, step1SignalId, expiresAt, htfCandle,
  htfHigh, htfLow, htfCandleOpenTime, htfCandleCloseTime, oteTop, oteBottom, zoneType,
  signalId, step, oteEnabled, sweepRequired, triggerType, s1Sent,
  mssRunHigh, mssRunLow, mssTf, target1, target2, hardKillLevel, dailyBias,
}) {
  const nowISO = new Date().toISOString();
  await db.prepare(`
    INSERT INTO chain_state
    (template_type,user_id,asset_id,symbol,htf,ltf,direction,state,step1_signal_id,
     htf_candle_open,htf_candle_close,htf_candle_open_time,htf_candle_close_time,
     expires_at,created_at,
     htf_high,htf_low,ote_top,ote_bottom,zone_type,
     signal_id,step,ote_enabled,sweep_required,trigger_type,s1_sent,
     mss_run_high,mss_run_low,mss_tf,target_1,target_2,hard_kill_level,daily_bias)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    templateType, userId, assetId, symbol, htf, ltf, direction, state, step1SignalId ?? null,
    htfCandle?.open ?? null, htfCandle?.close ?? null,
    // T2's only current caller passes these nested inside htfCandle; T1/T3
    // pass them flat — flat wins if both are somehow present.
    htfCandleOpenTime ?? htfCandle?.openTime ?? null,
    htfCandleCloseTime ?? htfCandle?.closeTime ?? null,
    expiresAt, nowISO,
    htfHigh ?? null, htfLow ?? null, oteTop ?? null, oteBottom ?? null, zoneType ?? null,
    signalId ?? null, step ?? 1, oteEnabled ?? 1, sweepRequired ?? 0, triggerType ?? 'cisd',
    s1Sent ? 1 : 0,
    mssRunHigh ?? null, mssRunLow ?? null, mssTf ?? null,
    target1 ?? null, target2 ?? null, hardKillLevel ?? null, dailyBias ?? null
  ).run();
}

async function cleanupExpiredChains(db) {
  const nowISO = new Date().toISOString();
  await db.prepare('DELETE FROM chain_state WHERE expires_at < ?').bind(nowISO).run();
}

// T1/T2/T4 counters, alongside the existing 'T3' row. Ported verbatim
// from ebp-worker.js's generator so
// both workers share the same global per-template signal_counters row.
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

// ── Candle Cache reads (inlined — no cross-package imports) ──
// Watchdog Worker is the sole Twelve Data / Yahoo caller and the sole
// writer of candle_cache / daily_candle_cache / weekly_candle_cache.
// Sweep Worker only reads, same pattern as EBP Worker.

// M15/M30/1H/4H — read the JSON blob Watchdog writes per fetch cycle.
// Stale cache (Watchdog missed a cycle, all TD keys + Yahoo failed, etc.)
// is treated as no data rather than risking detection on old bars.
export async function getCandlesFromCache(symbol, tf, env) {
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
// string, not a candle-open timestamp — reconstruct bar.time from the
// trading-day boundary (17:00 NY the prior calendar day), same approach
// as EBP Worker's cache readers.
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

async function getWeeklyCandlesFromCache(symbol, env) {
  const { results } = await env.DB.prepare(
    'SELECT week_start_ny, week_end_ny, open, high, low, close FROM weekly_candle_cache WHERE symbol = ? ORDER BY week_start_ny DESC LIMIT 5'
  ).bind(symbol).all();
  return (results ?? []).map(r => ({
    open: r.open, high: r.high, low: r.low, close: r.close,
    time: nyDateAtHourToUTCms(addDaysToDateStr(r.week_start_ny, -1), 17),
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
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit',
    hour12: true, month: 'short', day: 'numeric',
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

function formatSweepAlert({ symbol, tf, direction, candleTime, trendBias, trendAligned, sweptLevel, closedInsideLevel, trendMode, biasTF }) {
  const emoji     = direction === 'bullish' ? '🟢' : '🔴';
  const label     = direction === 'bullish' ? 'BULLISH SWEEP' : 'BEARISH SWEEP';
  const alignMark = trendAligned ? '✅' : trendMode === 'price_action' ? '📊 Price Action' : '⚠️ No Trend Filter';
  const swept     = direction === 'bullish' ? 'Low swept' : 'High swept';
  return `${emoji} <b>${label} — ${symbol}</b>
⏱ Timeframe: ${tf}
🕐 Candle: ${fmtNY(candleTime)} NY
📊 Trend: ${trendBias} (${getHTFBiasLabel(biasTF)}) ${alignMark}
━━━━━━━━━━━━━━
${swept}: ${sweptLevel}
Closed inside: ${closedInsideLevel}
━━━━━━━━━━━━━━
<i>EBP Tracker</i>`;
}

// ── Sweep Detection (inlined from sweep.js) ──────────────────

export function detectSweep(candles) {
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

// ── Swing State + MSS Engine (inlined) ────────

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

/**
 * Detects CISD (Change In State of Delivery) using locked TTrades definition.
 *
 * Bullish setup (bearish pullback):
 * - Find most recent consecutive series of bearish candles (close < open)
 *   working backwards from candles[candles.length-2]
 * - Within that series find candle with HIGHEST high
 * - cisdLevel = that candle's open
 * - Confirmed when candles[candles.length-1].close > cisdLevel
 *
 * Bearish setup (bullish pullback): exact mirror
 * - Most recent consecutive series of bullish candles (close > open)
 * - Candle with LOWEST low in that series
 * - cisdLevel = that candle's open
 * - Confirmed when candles[candles.length-1].close < cisdLevel
 *
 * @param {Array} candles - oldest-first candle array, minimum 2 candles
 * @param {string} direction - 'bullish' | 'bearish'
 * @returns {{ confirmed: boolean, cisdLevel: number | null }}
 */
function detectCISD(candles, direction) {
  if (!candles || candles.length < 2) return { confirmed: false, cisdLevel: null };

  const confirmCandle = candles[candles.length - 1];
  const lookback = candles.slice(0, candles.length - 1); // exclude confirm candle

  if (direction === 'bullish') {
    // Find most recent consecutive bearish series working backwards
    let seriesEnd = lookback.length - 1;
    // Find where series starts (walk back while candle is bearish)
    let seriesStart = seriesEnd;
    while (seriesStart > 0 && lookback[seriesStart - 1].close < lookback[seriesStart - 1].open) {
      seriesStart--;
    }
    // Must have at least one bearish candle
    if (lookback[seriesEnd].close >= lookback[seriesEnd].open) {
      return { confirmed: false, cisdLevel: null }; // last lookback candle not bearish
    }
    const series = lookback.slice(seriesStart, seriesEnd + 1);
    // Find highest high candle in series
    const highestHighCandle = series.reduce((best, c) => c.high > best.high ? c : best, series[0]);
    const cisdLevel = highestHighCandle.open;
    return { confirmed: confirmCandle.close > cisdLevel, cisdLevel };

  } else { // bearish
    // Find most recent consecutive bullish series working backwards
    let seriesEnd = lookback.length - 1;
    let seriesStart = seriesEnd;
    while (seriesStart > 0 && lookback[seriesStart - 1].close > lookback[seriesStart - 1].open) {
      seriesStart--;
    }
    if (lookback[seriesEnd].close <= lookback[seriesEnd].open) {
      return { confirmed: false, cisdLevel: null };
    }
    const series = lookback.slice(seriesStart, seriesEnd + 1);
    // Find lowest low candle in series
    const lowestLowCandle = series.reduce((best, c) => c.low < best.low ? c : best, series[0]);
    const cisdLevel = lowestLowCandle.open;
    return { confirmed: confirmCandle.close < cisdLevel, cisdLevel };
  }
}

/**
 * Detects MSS (Market Structure Shift) using locked TTrades definition.
 *
 * MSS level = high/low of the ENTIRE pullback run (stored at chain initiation).
 * NOT the most recent swing high — the macro run origin.
 *
 * Bullish: body closes above pullbackRunHigh (entire bearish run's starting high)
 * Bearish: body closes below pullbackRunLow (entire bullish run's starting low)
 *
 * @param {Array} candles - oldest-first candle array
 * @param {string} direction - 'bullish' | 'bearish'
 * @param {number|null} pullbackRunHigh - stored at chain arm time (bull setup)
 * @param {number|null} pullbackRunLow - stored at chain arm time (bear setup)
 * @returns {{ confirmed: boolean, mssLevel: number | null }}
 */
function detectMSSNew(candles, direction, pullbackRunHigh, pullbackRunLow) {
  if (!candles || candles.length < 1) return { confirmed: false, mssLevel: null };
  const confirmCandle = candles[candles.length - 1];

  if (direction === 'bullish') {
    if (pullbackRunHigh == null) return { confirmed: false, mssLevel: null };
    return { confirmed: confirmCandle.close > pullbackRunHigh, mssLevel: pullbackRunHigh };
  } else {
    if (pullbackRunLow == null) return { confirmed: false, mssLevel: null };
    return { confirmed: confirmCandle.close < pullbackRunLow, mssLevel: pullbackRunLow };
  }
}

// table: 'swing_states' | 'nse_swing_states'. Only the newest bar
// (candlesOldestFirst's last element) is a genuinely new close each cron
// cycle — the array's second-to-last element is used only as the
// comparison bar when bootstrapping run_dir from empty state.
async function updateSwingState(db, table, symbol, timeframe, candlesOldestFirst) {
  try {
  console.log(`[SWING] Processing ${symbol} ${timeframe}`);
  const bar     = candlesOldestFirst[candlesOldestFirst.length - 1];
  const prevBar = candlesOldestFirst[candlesOldestFirst.length - 2] ?? null;
  const nowISO  = new Date().toISOString();

  let state = await db.prepare(`SELECT * FROM ${table} WHERE symbol=? AND tf=?`).bind(symbol, timeframe).first();
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
    symbol, timeframe, state.run_dir, state.run_start_time, state.run_candle_count,
    state.last_confirmed_swing_high, state.last_confirmed_swing_high_time,
    state.last_confirmed_swing_low, state.last_confirmed_swing_low_time,
    state.pending_swing_high, state.pending_swing_high_time,
    state.pending_swing_low, state.pending_swing_low_time,
    state.updated_at
  ).run();

  return mssResult;
  } catch (e) {
    console.error(`[SWING] ERROR ${symbol} ${timeframe}: ${e.message}\n${e.stack}`);
    return null;
  }
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

// ── FVG Engine (inlined) ────────────────────────────

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
// rule: '50_percent' (default, body close beyond midpoint) | 'any_touch'
// (close anywhere inside/beyond the zone) | 'full_fill' (close fully beyond
// the far edge). processFVGZones' own mitigation sweep (which sets
// fvg_zones.mitigated_at) always uses the default.
function checkFVGMitigation(bar, fvgRow, rule = '50_percent') {
  if (rule === 'any_touch') {
    if (fvgRow.direction === 'bullish') return bar.close <= fvgRow.top;
    return bar.close >= fvgRow.bottom;
  }
  if (rule === 'full_fill') {
    if (fvgRow.direction === 'bullish') return bar.close < fvgRow.bottom;
    return bar.close > fvgRow.top;
  }
  if (fvgRow.direction === 'bullish') return bar.close < fvgRow.midpoint;
  return bar.close > fvgRow.midpoint;
}

// table: 'fvg_zones' | 'nse_fvg_zones'. candlesOldestFirst is the existing
// 3-item [older, prior, current] window already threaded through this file.
async function processFVGZones(db, table, symbol, timeframe, candlesOldestFirst, latestBar) {
  try {
  console.log(`[FVG] Processing ${symbol} ${timeframe}`);
  const nowISO = new Date().toISOString();

  const fvg = detectFVG(candlesOldestFirst);
  if (fvg) {
    // Dedup guard: skip if an active zone with the same direction already
    // overlaps this price range.
    const existing = await db.prepare(
      `SELECT id FROM ${table} WHERE symbol=? AND tf=? AND direction=? AND mitigated_at IS NULL AND expires_at > ?
       AND top >= ? AND bottom <= ? LIMIT 1`
    ).bind(symbol, timeframe, fvg.direction, nowISO, fvg.bottom, fvg.top).first();

    if (!existing) {
      const formedAtISO = new Date(fvg.formed_at).toISOString();
      const expiresAt   = new Date(fvg.formed_at + 14 * 24 * 60 * 60 * 1000).toISOString();
      await db.prepare(
        `INSERT INTO ${table} (symbol, tf, direction, top, bottom, midpoint, formed_at, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(symbol, timeframe, fvg.direction, fvg.top, fvg.bottom, fvg.midpoint, formedAtISO, expiresAt, nowISO).run();
    }
  }

  const { results: activeFVGs } = await db.prepare(
    `SELECT * FROM ${table} WHERE symbol=? AND tf=? AND mitigated_at IS NULL AND expires_at > ?`
  ).bind(symbol, timeframe, nowISO).all();

  for (const row of activeFVGs ?? []) {
    if (checkFVGMitigation(latestBar, row)) {
      await db.prepare(`UPDATE ${table} SET mitigated_at=?, mitigated_by_tf=? WHERE id=?`)
        .bind(nowISO, timeframe, row.id).run();
    }
  }
  } catch (e) {
    console.error(`[FVG] ERROR ${symbol} ${timeframe}: ${e.message}\n${e.stack}`);
  }
}

async function cleanupExpiredFVGs(db) {
  const nowISO = new Date().toISOString();
  await db.prepare(`DELETE FROM fvg_zones WHERE expires_at < ?`).bind(nowISO).run();
  await db.prepare(`DELETE FROM nse_fvg_zones WHERE expires_at < ?`).bind(nowISO).run();
}

// ── Template chains T1/T2/T3/T4 ─────
// Runs independently of user_sweep_configs — a user can enable a template
// on an LTF without separately subscribing to plain Sweep alerts on that
// same TF, so this pass is driven entirely by user_templates / chain_state,
// not the sweep-config symbolMap the main loop below builds.

async function getTelegramChat(db, userId) {
  const tg = await db.prepare(
    'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
  ).bind(userId).first();
  return tg?.chat_id ?? null;
}

/**
 * T1 alert — fires once at CISD confirmation (body close beyond FVG in OTE zone).
 * Single alert per chain. No initiation alert.
 */
function formatT1Alert({ symbol, htf, ltf, direction, fvg, entryPrice, target, signalId }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T1' : 'Bearish T1';
  const targetLabel = direction === 'bullish' ? 'Target (EBP High)' : 'Target (EBP Low)';
  return `${emoji} <b>${label} — ${symbol}</b>
⏱ HTF: ${htf} → LTF: ${ltf}
━━━━━━━━━━━━━━
📍 OTE FVG Zone: ${fvg.bottom.toFixed(5)} – ${fvg.top.toFixed(5)}
✅ CISD Confirmed
💰 Entry: ${entryPrice.toFixed(5)}
🎯 ${targetLabel}: ${target.toFixed(5)}
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}
EBP Tracker`;
}

/**
 * T2 S2 — zone entry alert. Sent when price first wicks into OTE/discount/premium zone.
 */
function formatT2S2Alert({ symbol, htf, ltf, direction, zoneType,
                           zoneTop, zoneBottom, entryPrice, signalId, hasEbpAlert }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T2' : 'Bearish T2';
  const zoneLabel = zoneType === 'ote' ? 'OTE Zone' :
                    zoneType === 'discount' ? 'Discount Zone' : 'Premium Zone';
  const suffix = hasEbpAlert ? '' : '/S2';
  return `${emoji} <b>${label} — Zone Entry — ${symbol}</b>
⏱ HTF: ${htf} → LTF: ${ltf}
━━━━━━━━━━━━━━
📍 ${zoneLabel}: ${zoneBottom.toFixed(5)} – ${zoneTop.toFixed(5)}
💰 Entry Price: ${entryPrice.toFixed(5)}
⏳ Watching for trigger...
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}${suffix}
EBP Tracker`;
}

/**
 * T2 sweep step alert (only when sweep_required=1).
 */
function formatT2SweepAlert({ symbol, htf, ltf, direction, sweepPrice,
                              signalId, stepSuffix }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T2' : 'Bearish T2';
  return `${emoji} <b>${label} — Sweep Confirmed — ${symbol}</b>
⏱ HTF: ${htf} → LTF: ${ltf}
━━━━━━━━━━━━━━
🌊 Sweep at: ${sweepPrice.toFixed(5)}
⏳ Watching for CISD / MSS...
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}${stepSuffix}
EBP Tracker`;
}

/**
 * T2 final trigger alert — CISD or MSS confirmed. Entry signal.
 */
function formatT2TriggerAlert({ symbol, htf, ltf, direction, triggerType,
                                triggerLevel, entryPrice, target,
                                signalId, stepSuffix }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T2' : 'Bearish T2';
  const trigLabel = triggerType === 'cisd' ? 'CISD Confirmed' : 'MSS Confirmed';
  const targetLabel = direction === 'bullish' ? 'Target (EBP High)' : 'Target (EBP Low)';
  return `${emoji} <b>${label} — ${trigLabel} — ${symbol}</b>
⏱ HTF: ${htf} → LTF: ${ltf}
━━━━━━━━━━━━━━
✅ ${trigLabel}: ${triggerLevel.toFixed(5)}
💰 Entry: ${entryPrice.toFixed(5)}
🎯 ${targetLabel}: ${target.toFixed(5)}
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}${stepSuffix}
EBP Tracker`;
}

// DST-aware NY hour for "now" — same technique deriveSession() uses for a
// given timestamp, adapted to read the current moment. Needed for T3's
// NY 23:00 time gate; avoids a toLocaleString→Date round-trip, which isn't
// standard/guaranteed-parseable behavior this codebase otherwise relies on.
function getCurrentNYHour() {
  const date  = new Date();
  const year  = date.getUTCFullYear();
  const march = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - march.getUTCDay()) % 7));
  const nov   = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, (7 - nov.getUTCDay()) % 7 + 1));
  dstStart.setUTCHours(7);
  dstEnd.setUTCHours(6);
  const isDST  = date >= dstStart && date < dstEnd;
  const offset = isDST ? 4 : 5;
  return (date.getUTCHours() - offset + 24) % 24;
}

// Today's NY 17:00 expressed as a UTC ISO string — T4's same-day expiry.
// Reuses nyDateAtHourToUTCms() (Intl/ICU-backed, more robust than
// getCurrentNYHour()'s hardcoded DST-rule reimplementation) rather than
// duplicating that technique a third time in this file. Callers must
// already have confirmed current NY time is before 17:00 (via
// getCurrentNYHour()) — this always computes forward from "today."
function getNY1700ExpiryISO() {
  const todayNYDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  return new Date(nyDateAtHourToUTCms(todayNYDateStr, 17)).toISOString();
}

// T3 S2 — FVG zone entry alert
function formatT3S2Alert({ symbol, ltf, direction, fvgTop, fvgBottom,
                           target, signalId }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T3' : 'Bearish T3';
  const targetLabel = direction === 'bullish'
    ? 'Target (Prev Day High)' : 'Target (Prev Day Low)';
  return `${emoji} <b>${label} — At Key Level — ${symbol}</b>
⏱ LTF: ${ltf}
━━━━━━━━━━━━━━
📍 FVG Zone: ${fvgBottom.toFixed(5)} – ${fvgTop.toFixed(5)}
🎯 ${targetLabel}: ${target.toFixed(5)}
⏳ Watching for trigger...
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}/S2
EBP Tracker`;
}

// T3 S3 — CISD or MSS trigger alert (entry signal)
function formatT3S3Alert({ symbol, ltf, direction, triggerType,
                           triggerLevel, entryPrice, target, signalId }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T3' : 'Bearish T3';
  const trigLabel = triggerType === 'cisd' ? 'CISD Confirmed' : 'MSS Confirmed';
  const targetLabel = direction === 'bullish'
    ? 'Target (Prev Day High)' : 'Target (Prev Day Low)';
  return `${emoji} <b>${label} — ${trigLabel} — ${symbol}</b>
⏱ LTF: ${ltf}
━━━━━━━━━━━━━━
✅ ${trigLabel}: ${triggerLevel.toFixed(5)}
💰 Entry: ${entryPrice.toFixed(5)}
🎯 ${targetLabel}: ${target.toFixed(5)}
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}/S3
EBP Tracker`;
}

// T4 S1 — MSS confirmed, chain armed
function formatT4S1Alert({ symbol, ltf, direction, mssLevel,
                           mssRunHigh, mssRunLow, signalId }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T4' : 'Bearish T4';
  const zoneLabel = direction === 'bullish' ? 'Discount Zone' : 'Premium Zone';
  const runRange = direction === 'bullish'
    ? `${mssRunLow?.toFixed(5)} – ${mssRunHigh?.toFixed(5)}`
    : `${mssRunHigh?.toFixed(5)} – ${mssRunLow?.toFixed(5)}`;
  return `${emoji} <b>${label} Armed — ${symbol}</b>
⏱ LTF: ${ltf}
━━━━━━━━━━━━━━
📊 MSS Confirmed: ${mssLevel?.toFixed(5)}
📍 Watching: ${zoneLabel} of MSS run (${runRange})
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}/S1
EBP Tracker`;
}

// T4 S2 — FVG entry + CISD confirmed, entry signal
function formatT4S2Alert({ symbol, ltf, direction, fvgTop, fvgBottom,
                           entryPrice, target1, target2, signalId }) {
  const emoji = direction === 'bullish' ? '🟢' : '🔴';
  const label = direction === 'bullish' ? 'Bullish T4' : 'Bearish T4';
  const t1Label = direction === 'bullish'
    ? 'T1 — Current Day High' : 'T1 — Current Day Low';
  const t2Label = direction === 'bullish'
    ? 'T2 — Prev Day High' : 'T2 — Prev Day Low';
  return `${emoji} <b>${label} — CISD Confirmed — ${symbol}</b>
⏱ LTF: ${ltf}
━━━━━━━━━━━━━━
📍 FVG Zone: ${fvgBottom.toFixed(5)} – ${fvgTop.toFixed(5)}
✅ CISD Confirmed
💰 Entry: ${entryPrice.toFixed(5)}
🎯 ${t1Label}: ${target1?.toFixed(5) ?? 'n/a'}
🎯 ${t2Label}: ${target2?.toFixed(5) ?? 'n/a'}
━━━━━━━━━━━━━━
🔗 Signal ID: ${signalId}/S2
EBP Tracker`;
}

async function processTemplateChains(tf, env, log) {
  const candleCache = new Map();

  // ── T4 CHAIN PROCESSING ──────────────────────────────────────────
  // Daily bias gate → intraday MSS (1H or M30) → premium/discount FVG
  // → M15 body close beyond FVG (CISD proxy) → entry alert
  // Two alerts: S1 (MSS arm), S2 (FVG CISD entry)
  try {

  // ── PHASE A: ARM — detect MSS and create new T4 chains ──
  const { results: t4TemplateRows } = await env.DB.prepare(`
    SELECT ut.*, ua.symbol, ua.asset_type, u.id as user_id
    FROM user_templates ut
    JOIN user_assets ua ON ut.asset_id = ua.id
    JOIN users u ON ut.user_id = u.id
    WHERE ut.template = 't4'
    AND ut.enabled = 1
    AND ut.ltf = ?
    AND u.active = 1
    AND ua.asset_type != 'nse'
  `).bind(tf).all();

  for (const tmpl of t4TemplateRows ?? []) {
    try {
      const mssTf = tmpl.mss_tf ?? '1H';

      if (!candleCache.has(`${tmpl.symbol}:${mssTf}`)) {
        candleCache.set(`${tmpl.symbol}:${mssTf}`, await getCandlesFromCache(tmpl.symbol, mssTf, env));
      }
      const mssCandles = candleCache.get(`${tmpl.symbol}:${mssTf}`);
      if (!mssCandles?.length) continue;

      // ── DAILY BIAS GATE ──
      const biasModeT4 = tmpl.bias_mode ?? 'auto';
      let t4Bias = 'neutral';

      if (biasModeT4 === 'manual') {
        t4Bias = tmpl.manual_bias ?? 'neutral';
      } else {
        if (!candleCache.has(`${tmpl.symbol}:D`)) {
          candleCache.set(`${tmpl.symbol}:D`, await getDailyCandlesFromCache(tmpl.symbol, env));
        }
        const dailyCandles = candleCache.get(`${tmpl.symbol}:D`);
        if (dailyCandles?.length >= 2) {
          // Four-scenario bias computation (locked spec)
          const today    = dailyCandles[0]; // most recent closed candle
          const prevDay  = dailyCandles[1];
          const todayBody = Math.abs(today.close - today.open);
          const prevBody  = Math.abs(prevDay.close - prevDay.open);
          const isSmallBody = todayBody < prevBody * 0.5;
          const sweptHigh  = today.high > prevDay.high;
          const sweptLow   = today.low  < prevDay.low;
          const closedInside = today.close < prevDay.high && today.close > prevDay.low;

          if (today.close > prevDay.high)                    t4Bias = 'bullish';
          else if (today.close < prevDay.low)                 t4Bias = 'bearish';
          else if (closedInside && sweptHigh && isSmallBody)  t4Bias = 'bearish';
          else if (closedInside && sweptLow  && isSmallBody)  t4Bias = 'bullish';
          else                                                  t4Bias = 'neutral';
        }
      }

      if (t4Bias === 'neutral') continue;

      // ── MSS DETECTION ──
      // Calls updateSwingState() directly (same function the main sweep
      // loop calls, further below in handleSweepCron) rather than passively
      // reading swing_states + detectMSSNew(): a passive read can't tell
      // "MSS just fired this tick" from "fired hours ago, nothing's moved
      // since" (the broken level isn't cleared — only run_dir flips, which
      // detectMSS()'s own internal gate relies on), and swing_states for
      // this mssTf might never get touched at all if no other user has a
      // plain Sweep config on this exact symbol+mssTf. Accepted trade-off:
      // if a plain Sweep subscriber also exists on this symbol+mssTf,
      // their tick later in handleSweepCron() re-processes the same bar —
      // a minor, self-correcting run_candle_count blip, not persistent
      // corruption.
      const mssOldestFirst = [...mssCandles].reverse();
      const mssResult = await updateSwingState(env.DB, 'swing_states', tmpl.symbol, mssTf, mssOldestFirst);
      if (!mssResult || mssResult.direction !== t4Bias) continue;

      // Read back the now-current swing state for both run extremes —
      // mssResult only carries the single level that broke (.level), not
      // the opposite side needed for the premium/discount zone.
      const swingState = await env.DB.prepare(
        'SELECT last_confirmed_swing_high, last_confirmed_swing_low FROM swing_states WHERE symbol=? AND tf=?'
      ).bind(tmpl.symbol, mssTf).first();
      if (!swingState) continue;

      // Dedup: skip if a T4 chain for this user+symbol+direction was
      // already created within the last window_mins (default 60).
      const windowMins = tmpl.window_mins ?? 60;
      const dedupCutoff = new Date(Date.now() - windowMins * 60 * 1000).toISOString();
      const existingChain = await env.DB.prepare(`
        SELECT id FROM chain_state
        WHERE template_type='T4' AND user_id=? AND symbol=?
        AND direction=? AND created_at > ? LIMIT 1
      `).bind(tmpl.user_id, tmpl.symbol, t4Bias, dedupCutoff).first();
      if (existingChain) continue;

      // MSS run range for premium/discount zone
      const mssRunHigh = swingState.last_confirmed_swing_high;
      const mssRunLow  = swingState.last_confirmed_swing_low;
      const mssRange   = (mssRunHigh ?? 0) - (mssRunLow ?? 0);

      let t4ZoneTop, t4ZoneBottom;
      if (t4Bias === 'bullish') {
        // Discount = below 50% of MSS run
        t4ZoneTop    = mssRunLow + mssRange * 0.5;
        t4ZoneBottom = mssRunLow;
      } else {
        // Premium = above 50% of MSS run
        t4ZoneBottom = mssRunHigh - mssRange * 0.5;
        t4ZoneTop    = mssRunHigh;
      }

      // Daily candles for targets and hard-kill level
      if (!candleCache.has(`${tmpl.symbol}:D`)) {
        candleCache.set(`${tmpl.symbol}:D`, await getDailyCandlesFromCache(tmpl.symbol, env));
      }
      const dc = candleCache.get(`${tmpl.symbol}:D`);
      const currentDay = dc?.[0];
      const prevDay    = dc?.[1];

      // Targets — Bull: T1=current day high, T2=prev day high.
      // Bear: T1=current day low, T2=prev day low.
      const target1 = t4Bias === 'bullish' ? currentDay?.high : currentDay?.low;
      const target2 = t4Bias === 'bullish' ? prevDay?.high    : prevDay?.low;

      // Hard kill level = previous day low (bull) / high (bear) — if
      // already swept before S2 fires, the chain is invalidated.
      const hardKillLevel = t4Bias === 'bullish' ? prevDay?.low : prevDay?.high;

      // Seed signal counter (idempotent) — must run before
      // generateSignalId(), which throws on a missing counter row.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO signal_counters (template,series,count) VALUES ('T4','A',0)`
      ).run();
      const t4SignalId = await generateSignalId(env.DB, 'T4', tmpl.symbol);

      // Expiry: today's NY 17:00. If already past, don't arm at all —
      // getNY1700ExpiryISO() always computes forward from "now."
      if (getCurrentNYHour() >= 17) continue;
      const t4ExpiresAt = getNY1700ExpiryISO();

      await insertChain(env.DB, {
        templateType: 'T4',
        userId: tmpl.user_id,
        assetId: tmpl.asset_id,
        symbol: tmpl.symbol,
        htf: 'D',
        ltf: tf,
        direction: t4Bias,
        state: 'awaiting_fvg_entry',
        expiresAt: t4ExpiresAt,
        signalId: t4SignalId,
        step: 1,
        mssRunHigh, mssRunLow, mssTf,
        oteTop: t4ZoneTop,
        oteBottom: t4ZoneBottom,
        zoneType: t4Bias === 'bullish' ? 'discount' : 'premium',
        target1, target2,
        hardKillLevel,
        dailyBias: t4Bias,
      });

      const t4Tg = await env.DB.prepare(
        'SELECT chat_id FROM user_telegram WHERE user_id=? AND verified=1 LIMIT 1'
      ).bind(tmpl.user_id).first();
      if (t4Tg?.chat_id) {
        await sendTelegramMessage(env.SHARED_BOT_TOKEN, t4Tg.chat_id,
          formatT4S1Alert({
            symbol: tmpl.symbol, ltf: tf, direction: t4Bias,
            mssLevel: mssResult.level,
            mssRunHigh, mssRunLow,
            signalId: t4SignalId,
          })
        );
      }

      log(`[${tmpl.symbol}] T4 chain armed (${t4Bias})`);
    } catch (e) {
      log(`T4 arm error ${tmpl.symbol}: ${e.message}`);
    }
  }

  // ── PHASE B: COMPLETE — check active T4 chains for FVG+CISD entry ──
  const { results: t4ActiveChains } = await env.DB.prepare(`
    SELECT * FROM chain_state
    WHERE template_type='T4'
    AND state='awaiting_fvg_entry'
    AND ltf=?
    AND expires_at > ?
  `).bind(tf, new Date().toISOString()).all();

  for (const chain of t4ActiveChains ?? []) {
    try {
      // ── HARD KILL CHECK ──
      if (!candleCache.has(chain.symbol)) {
        candleCache.set(chain.symbol, await getCandlesFromCache(chain.symbol, tf, env));
      }
      const t4Candles = candleCache.get(chain.symbol);
      if (!t4Candles?.length) continue;
      const latestCandle = t4Candles[0];

      const hardKillLevel = chain.hard_kill_level;
      if (hardKillLevel != null) {
        const hardKillTriggered = chain.direction === 'bullish'
          ? latestCandle.low  < hardKillLevel  // prev day low swept
          : latestCandle.high > hardKillLevel; // prev day high swept
        if (hardKillTriggered) {
          await env.DB.prepare('DELETE FROM chain_state WHERE id=?').bind(chain.id).run();
          log(`[${chain.symbol}] T4 chain killed — prev day extreme swept`);
          continue;
        }
      }

      // ── FVG LOOKUP ── Priority: 1H → M30 → M15 (first unmitigated FVG
      // in the premium/discount zone)
      let entryFvg = null;
      for (const fvgTf of ['1H', 'M30', 'M15']) {
        const fvgRow = await env.DB.prepare(`
          SELECT * FROM fvg_zones
          WHERE symbol=? AND tf=? AND direction=?
          AND mitigated_at IS NULL AND expires_at > ?
          AND bottom >= ? AND top <= ?
          ORDER BY formed_at DESC LIMIT 1
        `).bind(
          chain.symbol, fvgTf, chain.direction,
          new Date().toISOString(),
          chain.ote_bottom, chain.ote_top
        ).first();
        if (fvgRow) { entryFvg = fvgRow; break; }
      }
      if (!entryFvg) continue;

      // ── CISD CHECK (body close beyond FVG) ──
      const cisdConfirmed = chain.direction === 'bullish'
        ? latestCandle.close > entryFvg.top
        : latestCandle.close < entryFvg.bottom;
      if (!cisdConfirmed) continue;

      // ── SEND S2 ALERT ──
      const t4Tg2 = await env.DB.prepare(
        'SELECT chat_id FROM user_telegram WHERE user_id=? AND verified=1 LIMIT 1'
      ).bind(chain.user_id).first();

      if (t4Tg2?.chat_id) {
        await sendTelegramMessage(env.SHARED_BOT_TOKEN, t4Tg2.chat_id,
          formatT4S2Alert({
            symbol: chain.symbol, ltf: chain.ltf, direction: chain.direction,
            fvgTop: entryFvg.top, fvgBottom: entryFvg.bottom,
            entryPrice: latestCandle.close,
            target1: chain.target_1, target2: chain.target_2,
            signalId: chain.signal_id,
          })
        );
      }

      const firedAt = new Date().toISOString();

      // signals row — matches T1/T2/T3's completion convention (the given
      // spec only wrote alert_history; adding this for consistency with
      // every other template's completion, so T4 shows up in the signals
      // table like the rest).
      await env.DB.prepare(`
        INSERT INTO signals (
          signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at,
          price_at_signal, session
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        chain.signal_id, 'T4', chain.symbol, chain.htf, chain.ltf,
        chain.direction, firedAt, latestCandle.close, deriveSession(firedAt)
      ).run();

      await env.DB.prepare(`
        INSERT INTO alert_history
        (id, user_id, symbol, timeframe, direction, trend_bias,
         candle_time, fired_at, alert_type)
        VALUES (?,?,?,?,?,?,?,?,'t4')
      `).bind(
        crypto.randomUUID(), chain.user_id, chain.symbol, chain.ltf,
        chain.direction, chain.direction,
        latestCandle.time, firedAt
      ).run();

      await env.DB.prepare(
        `UPDATE chain_state SET state='complete', step=step+1 WHERE id=?`
      ).bind(chain.id).run();

      log(`[${chain.symbol}] T4 chain complete → ${chain.signal_id}`);
    } catch (e) {
      log(`T4 complete error ${chain.symbol}: ${e.message}`);
    }
  }

  } catch (e) {
    log(`T4 block error: ${e.message}`);
  }
  // ── END T4 PROCESSING ────────────────────────────────────────────

  // T1 Step 2 — CISD confirmation. T1 chains arm silently (ebp-worker.js)
  // with state='awaiting_cisd' and no signal ID; this is the only place
  // that alerts and completes them. T1 needs an FVG inside its own OTE
  // zone (not the EBP candle body) plus a CISD close-beyond-FVG trigger.
  const { results: t1Chains } = await env.DB.prepare(
    `SELECT * FROM chain_state WHERE template_type='T1' AND state='awaiting_cisd' AND ltf=? AND expires_at > ?`
  ).bind(tf, new Date().toISOString()).all();

  for (const chain of t1Chains ?? []) {
    try {
      if (!candleCache.has(chain.symbol)) {
        candleCache.set(chain.symbol, await getCandlesFromCache(chain.symbol, tf, env));
      }
      const candles = candleCache.get(chain.symbol);
      if (!candles || candles.length < 1) continue;
      const latestCandle = candles[0];

      // STEP A — most recent qualifying FVG: same symbol/tf/direction as
      // the chain, still live (fvg_zones has no `active` column — live is
      // mitigated_at IS NULL AND expires_at > now, same as everywhere else
      // in this file), formed inside the T1 HTF EBP candle's window
      // (formed_at/htf_candle_open_time/close_time are all TEXT ISO —
      // direct string comparison, no epoch conversion), and fully
      // contained within the chain's OTE zone.
      const nowISO = new Date().toISOString();
      const { results: t1Fvgs } = await env.DB.prepare(`
        SELECT * FROM fvg_zones
        WHERE symbol=? AND tf=? AND direction=?
          AND mitigated_at IS NULL AND expires_at > ?
          AND formed_at >= ? AND formed_at <= ?
          AND bottom >= ? AND top <= ?
        ORDER BY formed_at DESC
        LIMIT 1
      `).bind(
        chain.symbol, chain.ltf, chain.direction,
        nowISO,
        chain.htf_candle_open_time, chain.htf_candle_close_time,
        chain.ote_bottom, chain.ote_top
      ).all();
      const fvg = t1Fvgs?.[0];

      // STEP B
      if (!fvg) continue;

      // STEP C — CISD trigger: body close beyond the FVG.
      const cisdConfirmed = chain.direction === 'bullish'
        ? latestCandle.close > fvg.top
        : latestCandle.close < fvg.bottom;
      if (!cisdConfirmed) continue;

      // STEP D — CISD confirmed: signal ID assigned here (T1 gets no ID
      // at arm time), alert, complete the chain, record signals + alert_history.
      const signalId = await generateSignalId(env.DB, 'T1', chain.symbol);

      const chatId = await getTelegramChat(env.DB, chain.user_id);
      if (chatId) {
        const target = chain.direction === 'bullish' ? chain.htf_high : chain.htf_low;
        const msg = formatT1Alert({
          symbol: chain.symbol, htf: chain.htf, ltf: chain.ltf, direction: chain.direction,
          fvg, entryPrice: latestCandle.close, target, signalId,
        });
        await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId, msg);
      }

      await env.DB.prepare(
        `UPDATE chain_state SET state='complete', signal_id=?, fvg_id=?, step=1 WHERE id=?`
      ).bind(signalId, fvg.id, chain.id).run();

      const firedAt = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO signals (
          signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at,
          price_at_signal, session
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        signalId, 'T1', chain.symbol, chain.htf, chain.ltf,
        chain.direction, firedAt, latestCandle.close, deriveSession(firedAt)
      ).run();

      // trend_bias is NOT NULL on alert_history — T1's own bias_gate check
      // already happened at arm time in ebp-worker.js, so there's no
      // separate live bias value here; chain.direction (the armed,
      // already-aligned direction) is the correct value.
      await env.DB.prepare(`
        INSERT INTO alert_history
        (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
        VALUES (?,?,?,?,?,?,?,?,'t1')
      `).bind(
        crypto.randomUUID(), chain.user_id, chain.symbol, chain.ltf,
        chain.direction, chain.direction, latestCandle.time, firedAt
      ).run();

      log(`[${chain.symbol}] T1 chain complete → ${signalId}`);
    } catch (err) {
      console.error(`T1 CISD check error ${chain.symbol} ${tf}:`, err.message);
    }
  }

  // ── T2 CHAIN PROCESSING ──────────────────────────────────────────
  // New locked spec: 4H EBP → zone entry → optional sweep → CISD or MSS.
  // Signal ID + s1_sent are decided at arm time in ebp-worker.js; this is
  // the only place that advances/completes T2 chains from here on.
  // Filtered to ltf=tf (same as the T4/T1 blocks above) so the shared
  // candleCache — populated via getCandlesFromCache(symbol, tf, env) — is
  // guaranteed to hold candles for this chain's own ltf, not some other one.
  const { results: t2Chains } = await env.DB.prepare(`
    SELECT * FROM chain_state
    WHERE template_type='T2' AND state != 'complete' AND ltf=? AND expires_at > ?
  `).bind(tf, new Date().toISOString()).all();

  for (const chain of t2Chains ?? []) {
    try {
      if (!candleCache.has(chain.symbol)) {
        candleCache.set(chain.symbol, await getCandlesFromCache(chain.symbol, tf, env));
      }
      const t2Candles = candleCache.get(chain.symbol);
      if (!t2Candles || t2Candles.length < 1) continue;
      const latestCandle = t2Candles[0];

      const chatId = await getTelegramChat(env.DB, chain.user_id);

      // Signal ID suffix: s1_sent=1 → S1 occupied the "/S1" slot, so
      // zone-entry is /S2, sweep (if any) is /S3, trigger is /S3 or /S4.
      // s1_sent=0 → S1 was silent, so zone-entry is /S1, sweep is /S2,
      // trigger is /S2 or /S3.
      const stepOffset = chain.s1_sent ? 1 : 0;

      // Incremental pullback-run high/low — updated on every tick once the
      // chain has entered a sweep/trigger-watching state, before any
      // trigger/hard-kill check. candle_cache only holds a rolling
      // few-candle window (UNIQUE(symbol,tf), one row), not history back to
      // zone entry, so this can't be reconstructed after the fact — it has
      // to accrue tick by tick from the moment price enters the zone.
      let runHigh = chain.pullback_run_high;
      let runLow  = chain.pullback_run_low;
      if (chain.state === 'awaiting_sweep' || chain.state === 'awaiting_trigger') {
        runHigh = Math.max(runHigh ?? latestCandle.high, latestCandle.high);
        runLow  = Math.min(runLow  ?? latestCandle.low,  latestCandle.low);
        if (runHigh !== chain.pullback_run_high || runLow !== chain.pullback_run_low) {
          await env.DB.prepare(
            'UPDATE chain_state SET pullback_run_high=?, pullback_run_low=? WHERE id=?'
          ).bind(runHigh, runLow, chain.id).run();
        }
      }

      // ── HARD KILL: zone exit check (awaiting_sweep / awaiting_trigger) ──
      if (chain.state === 'awaiting_sweep' || chain.state === 'awaiting_trigger') {
        const exitedZone = chain.direction === 'bullish'
          ? latestCandle.low < chain.ote_bottom   // bull: price broke below zone floor
          : latestCandle.high > chain.ote_top;    // bear: price broke above zone ceiling
        if (exitedZone) {
          await env.DB.prepare('DELETE FROM chain_state WHERE id=?').bind(chain.id).run();
          log(`[${chain.symbol}] T2 chain killed — zone exit`);
          continue;
        }
      }

      // ── STATE: awaiting_zone_entry ──
      if (chain.state === 'awaiting_zone_entry') {
        // Bull: candle low <= zone_top (wick entered zone from above)
        // Bear: candle high >= zone_bottom (wick entered zone from below)
        const wickedZone = chain.direction === 'bullish'
          ? latestCandle.low <= chain.ote_top
          : latestCandle.high >= chain.ote_bottom;
        if (!wickedZone) continue;

        const nextState = chain.sweep_required ? 'awaiting_sweep' : 'awaiting_trigger';
        // The wick that actually entered the zone is the low (bull) or
        // high (bear) — not always the low regardless of direction.
        const zoneEntryPrice = chain.direction === 'bullish' ? latestCandle.low : latestCandle.high;

        await env.DB.prepare(`
          UPDATE chain_state SET state=?, step=step+1,
          zone_entry_price=?, zone_entry_time=?,
          pullback_run_high=?, pullback_run_low=?
          WHERE id=?
        `).bind(
          nextState, zoneEntryPrice, new Date().toISOString(),
          latestCandle.high, latestCandle.low, chain.id
        ).run();

        if (chatId) {
          const s2Suffix = `/S${2 + stepOffset}`;
          const s2Text = formatT2S2Alert({
            symbol: chain.symbol, htf: chain.htf, ltf: chain.ltf,
            direction: chain.direction,
            zoneType: chain.zone_type,
            zoneTop: chain.ote_top, zoneBottom: chain.ote_bottom,
            entryPrice: zoneEntryPrice,
            // formatT2S2Alert's own hasEbpAlert flag only supports '' or a
            // hardcoded '/S2' — doesn't fit the dynamic /S2../S4 numbering
            // the other two T2 formatters take via stepSuffix. The correct
            // suffix is precomputed and embedded in signalId above;
            // hasEbpAlert:true suppresses the formatter's own suffix so it
            // isn't appended twice.
            signalId: chain.signal_id + s2Suffix,
            hasEbpAlert: true,
          });
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId, s2Text);
        }
        continue;
      }

      // ── STATE: awaiting_sweep ──
      if (chain.state === 'awaiting_sweep') {
        // Self-contained sweep check on this chain's own ltf candles — the
        // outer cron loop's sweep result isn't reachable from here
        // (processTemplateChains runs before that loop even queries data),
        // so this mirrors the T4 Step-1 block above, which has the same
        // dependency and already calls detectSweep() locally.
        const sweep = detectSweep(t2Candles);
        if (!sweep || sweep.direction !== chain.direction) continue;

        await env.DB.prepare(
          `UPDATE chain_state SET state='awaiting_trigger', step=step+1 WHERE id=?`
        ).bind(chain.id).run();

        if (chatId) {
          const sweepSuffix = `/S${3 + stepOffset}`;
          const sweepText = formatT2SweepAlert({
            symbol: chain.symbol, htf: chain.htf, ltf: chain.ltf,
            direction: chain.direction,
            sweepPrice: sweep.closedInsideLevel ?? latestCandle.close,
            signalId: chain.signal_id,
            stepSuffix: sweepSuffix,
          });
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId, sweepText);
        }
        continue;
      }

      // ── STATE: awaiting_trigger ──
      if (chain.state === 'awaiting_trigger') {
        const oldestFirst = [...t2Candles].reverse();

        let triggered = false;
        let triggerLevel = null;

        if (chain.trigger_type === 'cisd') {
          const cisd = detectCISD(oldestFirst, chain.direction);
          if (cisd.confirmed) {
            triggered = true;
            triggerLevel = cisd.cisdLevel;
          }
        } else {
          // MSS — runHigh/runLow are this tick's already-updated running
          // pullback-run extremes (see the incremental tracker above).
          const mss = detectMSSNew(oldestFirst, chain.direction, runHigh, runLow);
          if (mss.confirmed) {
            triggered = true;
            triggerLevel = mss.mssLevel;
          }
        }

        if (!triggered) continue;

        const finalSuffix = `/S${(chain.sweep_required ? 4 : 3) + stepOffset}`;
        const target      = chain.direction === 'bullish' ? chain.htf_high : chain.htf_low;
        const entryPrice  = latestCandle.close;
        const firedAt     = new Date().toISOString();

        if (chatId) {
          const trigText = formatT2TriggerAlert({
            symbol: chain.symbol, htf: chain.htf, ltf: chain.ltf,
            direction: chain.direction,
            triggerType: chain.trigger_type,
            triggerLevel,
            entryPrice,
            target,
            signalId: chain.signal_id,
            stepSuffix: finalSuffix,
          });
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId, trigText);
        }

        await env.DB.prepare(`
          INSERT INTO signals (
            signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at,
            price_at_signal, session
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          chain.signal_id, 'T2', chain.symbol, chain.htf, chain.ltf,
          chain.direction, firedAt, entryPrice, deriveSession(firedAt)
        ).run();

        await env.DB.prepare(`
          INSERT INTO alert_history
          (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
          VALUES (?,?,?,?,?,?,?,?,'t2')
        `).bind(
          crypto.randomUUID(), chain.user_id, chain.symbol, chain.ltf,
          chain.direction, chain.direction, latestCandle.time, firedAt
        ).run();

        await env.DB.prepare(
          `UPDATE chain_state SET state='complete', step=step+1 WHERE id=?`
        ).bind(chain.id).run();

        log(`[${chain.symbol}] T2 chain complete → ${chain.signal_id}`);
      }
    } catch (err) {
      console.error(`T2 chain processing error ${chain.symbol} ${tf}:`, err.message);
    }
  }
  // ── END T2 PROCESSING ────────────────────────────────────────────

  // ── T3 CHAIN PROCESSING ──────────────────────────────────────────
  // Daily candle → 50–75% zone FVG → CISD or MSS
  // State flow: awaiting_time_gate → awaiting_key_level → awaiting_trigger → complete
  // Two alerts: S2 (FVG entry), S3 (CISD/MSS trigger)

  const { results: t3ChainRows } = await env.DB.prepare(`
    SELECT * FROM chain_state
    WHERE template_type='T3'
    AND state NOT IN ('complete')
    AND ltf=?
    AND expires_at > ?
  `).bind(tf, new Date().toISOString()).all();

  for (const chain of t3ChainRows ?? []) {
    try {

    // ── TIME GATE: NY 23:00 ──
    // T3 only activates after NY 23:00 on the day it was armed.
    if (chain.state === 'awaiting_time_gate') {
      if (getCurrentNYHour() < 23) continue; // before NY 23:00 — wait
      // Time gate passed — advance to awaiting_key_level
      await env.DB.prepare(
        'UPDATE chain_state SET state=\'awaiting_key_level\', step=step+1 WHERE id=?'
      ).bind(chain.id).run();
      chain.state = 'awaiting_key_level'; // update local copy to continue processing
    }

    // ── STATE: awaiting_key_level ──
    // Look for unmitigated FVG in 50–75% zone
    // Priority: 4H FVG first, fallback to 1H FVG
    if (chain.state === 'awaiting_key_level') {
      let fvg = null;

      // Try 4H FVG first
      const fvg4h = await env.DB.prepare(`
        SELECT * FROM fvg_zones
        WHERE symbol=? AND tf='4H' AND direction=?
        AND mitigated_at IS NULL AND expires_at > ?
        AND bottom >= ? AND top <= ?
        ORDER BY formed_at DESC LIMIT 1
      `).bind(
        chain.symbol, chain.direction, new Date().toISOString(),
        chain.ote_bottom, chain.ote_top
      ).first();

      if (fvg4h) {
        fvg = fvg4h;
      } else {
        // Fallback to 1H FVG
        const fvg1h = await env.DB.prepare(`
          SELECT * FROM fvg_zones
          WHERE symbol=? AND tf='1H' AND direction=?
          AND mitigated_at IS NULL AND expires_at > ?
          AND bottom >= ? AND top <= ?
          ORDER BY formed_at DESC LIMIT 1
        `).bind(
          chain.symbol, chain.direction, new Date().toISOString(),
          chain.ote_bottom, chain.ote_top
        ).first();
        if (fvg1h) fvg = fvg1h;
      }

      if (!fvg) continue; // no qualifying FVG found yet — wait

      // FVG found — store and advance state (wait for price to wick it)
      await env.DB.prepare(`
        UPDATE chain_state SET state='awaiting_trigger',
        key_level_fvg_id=?, step=step+1 WHERE id=?
      `).bind(fvg.id, chain.id).run();
      chain.state = 'awaiting_trigger';
      chain.key_level_fvg_id = fvg.id;
    }

    // ── STATE: awaiting_trigger ──
    if (chain.state === 'awaiting_trigger') {

      // Fetch the stored FVG
      const fvg = await env.DB.prepare(
        'SELECT * FROM fvg_zones WHERE id=?'
      ).bind(chain.key_level_fvg_id).first();

      if (!fvg) {
        // FVG was mitigated or deleted — hard kill chain
        await env.DB.prepare('DELETE FROM chain_state WHERE id=?').bind(chain.id).run();
        continue;
      }

      // Fetch LTF candles — shared candleCache Map, same pattern T1/T2 use
      // (safe because the outer query already filters chain.ltf === tf).
      if (!candleCache.has(chain.symbol)) {
        candleCache.set(chain.symbol, await getCandlesFromCache(chain.symbol, tf, env));
      }
      const t3Candles = candleCache.get(chain.symbol);
      if (!t3Candles?.length) continue;
      const latestCandle = t3Candles[0];

      // Check if price has wicked into FVG
      // Bull: low <= fvg.top (wick entered FVG from above)
      // Bear: high >= fvg.bottom (wick entered FVG from below)
      const wickedFvg = chain.direction === 'bullish'
        ? latestCandle.low <= fvg.top
        : latestCandle.high >= fvg.bottom;

      // Update pullback run tracking (for MSS)
      await env.DB.prepare(`
        UPDATE chain_state
        SET pullback_run_high = MAX(COALESCE(pullback_run_high, ?), ?),
            pullback_run_low  = MIN(COALESCE(pullback_run_low,  ?), ?)
        WHERE id=?
      `).bind(
        latestCandle.high, latestCandle.high,
        latestCandle.low,  latestCandle.low,
        chain.id
      ).run();

      // Send S2 alert on first FVG wick
      // Only send S2 once — check if zone_entry_time is already set
      if (wickedFvg && !chain.zone_entry_time) {
        await env.DB.prepare(`
          UPDATE chain_state SET zone_entry_price=?, zone_entry_time=? WHERE id=?
        `).bind(latestCandle.close, new Date().toISOString(), chain.id).run();

        const t3Tg = await env.DB.prepare(
          'SELECT chat_id FROM user_telegram WHERE user_id=? AND verified=1 LIMIT 1'
        ).bind(chain.user_id).first();

        if (t3Tg?.chat_id) {
          const target = chain.direction === 'bullish' ? chain.htf_high : chain.htf_low;
          const s2Text = formatT3S2Alert({
            symbol: chain.symbol, ltf: chain.ltf, direction: chain.direction,
            fvgTop: fvg.top, fvgBottom: fvg.bottom,
            target, signalId: chain.signal_id,
          });
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, t3Tg.chat_id, s2Text);
        }

        chain.zone_entry_time = new Date().toISOString(); // update local copy
      }

      // Only evaluate trigger after FVG has been wicked
      if (!chain.zone_entry_time && !wickedFvg) continue;

      // Fetch updated pullback tracking values
      const updatedChain = await env.DB.prepare(
        'SELECT pullback_run_high, pullback_run_low FROM chain_state WHERE id=?'
      ).bind(chain.id).first();

      // Evaluate CISD or MSS
      const oldestFirst = [...t3Candles].reverse();
      let triggered = false;
      let triggerLevel = null;

      if (chain.trigger_type === 'cisd') {
        const cisd = detectCISD(oldestFirst, chain.direction);
        if (cisd.confirmed) { triggered = true; triggerLevel = cisd.cisdLevel; }
      } else {
        const mss = detectMSSNew(
          oldestFirst, chain.direction,
          updatedChain?.pullback_run_high ?? null,
          updatedChain?.pullback_run_low  ?? null
        );
        if (mss.confirmed) { triggered = true; triggerLevel = mss.mssLevel; }
      }

      if (!triggered) continue;

      // Fetch telegram
      const t3Tg2 = await env.DB.prepare(
        'SELECT chat_id FROM user_telegram WHERE user_id=? AND verified=1 LIMIT 1'
      ).bind(chain.user_id).first();

      if (t3Tg2?.chat_id) {
        const target = chain.direction === 'bullish' ? chain.htf_high : chain.htf_low;
        const s3Text = formatT3S3Alert({
          symbol: chain.symbol, ltf: chain.ltf, direction: chain.direction,
          triggerType: chain.trigger_type,
          triggerLevel,
          entryPrice: latestCandle.close,
          target, signalId: chain.signal_id,
        });
        await sendTelegramMessage(env.SHARED_BOT_TOKEN, t3Tg2.chat_id, s3Text);
      }

      // Write alert_history
      await env.DB.prepare(`
        INSERT INTO alert_history
        (id, user_id, symbol, timeframe, direction, trend_bias,
         candle_time, fired_at, alert_type)
        VALUES (?,?,?,?,?,?,?,?,'t3')
      `).bind(
        crypto.randomUUID(), chain.user_id, chain.symbol, chain.ltf,
        chain.direction, chain.direction,
        latestCandle.time, new Date().toISOString()
      ).run();

      // Complete chain
      await env.DB.prepare(
        'UPDATE chain_state SET state=\'complete\', step=step+1 WHERE id=?'
      ).bind(chain.id).run();

      log(`[${chain.symbol}] T3 chain complete`);
    }
    } catch (err) {
      console.error(`T3 chain processing error ${chain.symbol} ${tf}:`, err.message);
    }
  }
  // ── END T3 PROCESSING ────────────────────────────────────────────
}

// ── Main cron handler ─────────────────────────────────────────

export async function handleSweepCron(tf, env, debugLog = null) {
  const log = (msg) => { console.log(msg); if (debugLog) debugLog.push(msg); };
  log(`Sweep trigger → TF: ${tf}`);

  // M15 is the smallest sweep tick, so the periodic FVG/chain cleanup runs
  // here. Sweep Worker no longer touches Twelve Data keys or api_call_log —
  // that's Watchdog's exclusive concern.
  if (tf === 'M15') {
    await cleanupExpiredFVGs(env.DB);
    await cleanupExpiredChains(env.DB);
    log('Cleaned up expired FVGs and chains');
  }

  // T1/T2/T4 chains, decoupled from the sweep-config-driven loop below
  // (see processTemplateChains comment for why).
  await processTemplateChains(tf, env, log);

  const { results: filtered } = await env.DB.prepare(`
    SELECT sc.id as config_id, sc.alert_mode, sc.htf_override,
           ua.id as asset_id, ua.symbol, ua.bias_overrides,
           u.id as user_id, u.active as user_active, u.user_tf_access
    FROM user_sweep_configs sc
    JOIN user_assets ua ON sc.asset_id = ua.id
    JOIN users u ON sc.user_id = u.id
    WHERE sc.timeframe=? AND sc.enabled=1
    AND u.active=1
  `).bind(tf).all();

  if (!filtered?.length) {
    log(`No sweep assets configured for ${tf}`);
    return;
  }

  log(`Processing ${filtered.length} asset-user pairs on ${tf}`);

  const symbolMap = new Map();
  for (const row of filtered) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, []);
    symbolMap.get(row.symbol).push(row);
  }

  const defaultBiasTF = BIAS_SOURCE.sweep[tf] ?? null;

  for (const [symbol, userRows] of symbolMap) {
    try {
      const candles = await getCandlesFromCache(symbol, tf, env);
      log(`[${symbol}] candles fetched: ${candles?.length ?? 'null'}`);
      if (!candles || candles.length < 2) {
        log(`[${symbol}] SKIP: insufficient candles in cache`);
        continue;
      }

      // Different users on this symbol+tf may have different htf_override
      // values, so bias must be computed per distinct HTF actually in use,
      // not once per symbol. resolveHTF() falls back to the BIAS_SOURCE
      // default when a row has no override, so this set always includes it.
      const neededHtfs = new Set(userRows.map(row => resolveHTF('sweep', tf, row.htf_override)).filter(Boolean));
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
        log(`[${symbol}] htf(${htf}) candles fetched: ${htfCandles?.length ?? 'null'}`);
        let bias = 'neutral';
        if (htfCandles?.length >= 2) {
          const biasResult = calcTTradesBias({ bar1: htfCandles[0], bar2: htfCandles[1] });
          biasResult.bar1Time = htfCandles[0].time;
          bias = biasResult.bias;
          await writeBiasCache(env.DB, symbol, htf, biasResult);
        }
        biasByTF.set(htf, bias);
      }
      // Symbol-level (not per-user) bias, used only for the log line below.
      const htfBias = defaultBiasTF ? (biasByTF.get(defaultBiasTF) ?? 'neutral') : 'neutral';

      // FVG + Swing/MSS — candles are newest-first; need oldest-first
      if (candles.length >= 3) {
        log(`[${symbol}] running FVG + swing (3 candles available)`);
        const oldestFirst = [candles[2], candles[1], candles[0]];
        await processFVGZones(env.DB, 'fvg_zones', symbol, tf, oldestFirst, candles[0]);

        const mssResult = await updateSwingState(env.DB, 'swing_states', symbol, tf, oldestFirst);
        log(`[${symbol}] MSS result: ${mssResult ? mssResult.direction : 'none'}`);
        if (mssResult) {
          for (const row of userRows) {
            const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
            if (!userTfAccess.includes(tf)) continue;

            const userBiasTF    = resolveHTF('sweep', tf, row.htf_override);
            const userHtfBias   = userBiasTF ? (biasByTF.get(userBiasTF) ?? 'neutral') : 'neutral';
            const alertMode     = row.alert_mode ?? 'aligned';
            const biasOverrides = JSON.parse(row.bias_overrides || '{}');
            const effectiveBias = getEffectiveBias(userBiasTF, { [userBiasTF]: { bias: userHtfBias } }, biasOverrides);
            const shouldAlert   = alertMode === 'all' || alertMode === 'price_action' ||
                                  mssResult.direction === effectiveBias || effectiveBias === 'neutral';
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

            const msg = formatMSSAlert(symbol, tf, mssResult, effectiveBias, getHTFBiasLabel(userBiasTF));
            await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);

            await env.DB.prepare(
              `INSERT INTO alert_history
               (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
               VALUES (?,?,?,?,?,?,?,?,'mss')`
            ).bind(
              crypto.randomUUID(), row.user_id, symbol, tf,
              mssResult.direction, effectiveBias, mssResult.candle_time, new Date().toISOString()
            ).run();
          }
        }
      }

      const sweep = detectSweep(candles);
      if (!sweep) {
        log(`[${symbol}] no sweep detected`);
        continue;
      }

      log(`[${symbol}] sweep detected: ${sweep.direction} (HTF bias: ${htfBias})`);

      for (const row of userRows) {
        const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
        if (!userTfAccess.includes(tf)) continue;

        const userBiasTF    = resolveHTF('sweep', tf, row.htf_override);
        const userHtfBias   = userBiasTF ? (biasByTF.get(userBiasTF) ?? 'neutral') : 'neutral';
        const alertMode     = row.alert_mode ?? 'aligned';
        const biasOverrides = JSON.parse(row.bias_overrides || '{}');
        const effectiveBias = getEffectiveBias(userBiasTF, { [userBiasTF]: { bias: userHtfBias } }, biasOverrides);
        const trendAligned  = sweep.direction === effectiveBias;

        const shouldAlert =
          alertMode === 'all' ||
          alertMode === 'price_action' ||
          (alertMode === 'aligned' && trendAligned);

        if (!shouldAlert) {
          log(`[${symbol}] skipping — trend not aligned`);
          continue;
        }

        const tg = await env.DB.prepare(
          'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
        ).bind(row.user_id).first();

        if (!tg?.chat_id) {
          console.log(`No verified Telegram for user ${row.user_id}`);
          continue;
        }

        const isDup = await isDuplicateAlert(env.DB, row.user_id, symbol, tf, sweep.direction, 'sweep');
        if (isDup) {
          console.log(`[${symbol}] DEDUP: skipping duplicate ${tf} ${sweep.direction} Sweep alert`);
          continue;
        }

        const sweepMsg = formatSweepAlert({
          symbol, tf,
          direction:         sweep.direction,
          candleTime:        sweep.candleTime,
          trendBias:         effectiveBias,
          trendAligned,
          sweptLevel:        sweep.sweptLevel?.toFixed(5),
          closedInsideLevel: sweep.closedInsideLevel?.toFixed(5),
          trendMode:         alertMode,
          biasTF:            userBiasTF,
        });

        await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, sweepMsg);
        console.log(`Sweep alert sent: ${symbol} ${tf} to user ${row.user_id}`);

        await env.DB.prepare(`
          INSERT INTO alert_history
          (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
          VALUES (?,?,?,?,?,?,?,?,'sweep')
        `).bind(
          crypto.randomUUID(), row.user_id, symbol, tf,
          sweep.direction, effectiveBias, sweep.candleTime, new Date().toISOString()
        ).run();

      }

      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`Error processing ${symbol} on ${tf}:`, err.message);
    }
  }

  console.log(`Sweep cron complete for ${tf}`);
}
