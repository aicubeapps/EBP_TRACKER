// ============================================================
// Sweep Worker Cron Handler — Standalone (no external imports)
// All core functions inlined to avoid Wrangler bundling issues
// with cross-package relative imports.
// ============================================================

// ── TTrades Closure Bias (inlined from packages/core/ttrades.js) ──

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

// ── Phase 3 — Bias Source Map ─────────────────────────────────
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

// ── Phase 3 — Chain State Machine (T1/T2/T3/T4) ───────────────
// chain_state schema (post Phase-1-to-3 migration): template_type/state
// (TEXT state machine, not the old current_step INTEGER), asset_id (kept
// beyond the original spec — user_templates and the EBP-worker
// asset-delete cascade are both asset_id-keyed), direction always
// 'bullish'/'bearish' (never 'bull'/'bear' — matches every detector in
// this codebase).

async function insertChain(db, { templateType, userId, assetId, symbol, htf, ltf, direction, state, step1SignalId, expiresAt, htfCandle }) {
  const nowISO = new Date().toISOString();
  await db.prepare(`
    INSERT INTO chain_state
    (template_type,user_id,asset_id,symbol,htf,ltf,direction,state,step1_signal_id,
     htf_candle_open,htf_candle_close,htf_candle_open_time,htf_candle_close_time,
     expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    templateType, userId, assetId, symbol, htf, ltf, direction, state, step1SignalId ?? null,
    htfCandle?.open ?? null, htfCandle?.close ?? null, htfCandle?.openTime ?? null, htfCandle?.closeTime ?? null,
    expiresAt, nowISO
  ).run();
}

// templateTypes: single string or array. direction/userId: omit to match any.
async function getChains(db, { templateTypes, state, symbol, direction, userId }) {
  const nowISO = new Date().toISOString();
  const types  = Array.isArray(templateTypes) ? templateTypes : [templateTypes];
  const placeholders = types.map(() => '?').join(',');
  let query = `SELECT * FROM chain_state WHERE template_type IN (${placeholders}) AND state=? AND symbol=? AND expires_at > ?`;
  const args = [...types, state, symbol, nowISO];
  if (direction) { query += ' AND direction=?'; args.push(direction); }
  if (userId)    { query += ' AND user_id=?';    args.push(userId); }
  const { results } = await db.prepare(query).bind(...args).all();
  return results ?? [];
}

async function advanceT3Chain(db, chainId) {
  await db.prepare(`UPDATE chain_state SET state='awaiting_mss' WHERE id=?`).bind(chainId).run();
}

async function completeT3Chain(db, chainId) {
  await db.prepare(`UPDATE chain_state SET state='complete' WHERE id=?`).bind(chainId).run();
}

// Shared by T1/T2/T4 — the only three templates whose completion is gated
// on a live FVG entry.
async function completeFvgEntryChain(db, chainId, signalId, fvgId) {
  await db.prepare(
    `UPDATE chain_state SET state='complete', step2_signal_id=?, fvg_id=? WHERE id=?`
  ).bind(signalId, fvgId, chainId).run();
}

async function cleanupExpiredChains(db) {
  const nowISO = new Date().toISOString();
  await db.prepare('DELETE FROM chain_state WHERE expires_at < ?').bind(nowISO).run();
}

// T1/T2/T4 counters — added by the Phase-1-to-3 migration alongside the
// existing 'T3' row. Ported verbatim from ebp-worker.js's generator so
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

// IM-4/5 — shared format across ebp-worker.js and sweep-cron.js. The
// Signal ID is assigned once at Step 1 (initiateT3Chain, in ebp-worker.js)
// and reused verbatim at Steps 2/3 via chain_state.step1_signal_id.
// direction is always 'bullish'/'bearish' throughout this codebase, never
// 'bull'/'bear'.
function formatT3Alert(symbol, htf, ltf, direction, session, price, signalId, step) {
  const emoji    = direction === 'bullish' ? '🟢' : '🔴';
  const dirLabel = direction === 'bullish' ? 'BULL' : 'BEAR';
  const stepLabel = '/S' + step;

  return [
    '🎯 T3 Chain — ' + symbol,
    'Step: S' + step + ' of 3',
    'HTF: ' + htf + ' EBP → LTF: ' + ltf + ' Sweep → LTF: ' + ltf + ' MSS',
    'Direction: ' + emoji + ' ' + dirLabel,
    'Session: ' + session,
    'Price: ' + price,
    'Signal ID: ' + signalId + stepLabel
  ].join('\n');
}

// T3 completing at Step 2 because the template's step3_enabled=0 — MSS is
// skipped entirely, chain completes on the sweep alone.
function formatT3Step2CompleteAlert(symbol, htf, ltf, direction, session, signalId) {
  const emoji    = direction === 'bullish' ? '🟢' : '🔴';
  const dirLabel = direction === 'bullish' ? 'BULL' : 'BEAR';
  return [
    '🎯 T3 Signal — ' + symbol,
    'HTF: ' + htf + ' EBP → LTF: ' + ltf + ' Sweep',
    'Direction: ' + emoji + ' ' + dirLabel,
    'Session: ' + session,
    'Signal ID: ' + signalId,
    'Note: Step 3 (MSS) disabled',
  ].join('\n');
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

// ── Telegram (inlined from packages/core/telegram.js) ────────

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

// ── Swing State + MSS Engine (Phase 1.5 + 2, inlined) ────────

function isDoji(bar, dojiThreshold) {
  return Math.abs(bar.close - bar.open) <= dojiThreshold;
}

// Real ATR(14) when enough history is passed in; the D1 candle cache this
// file reads from only ever exposes the 3-bar window already used
// elsewhere here, so this returns null in practice and callers fall back
// to (high-low)*0.1 per the Phase 1.5 spec — kept so it activates
// automatically if the cache is ever widened.
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

// ── FVG Engine (Phase 1, inlined) ────────────────────────────

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
// the far edge). Only checkFvgEntryChain's per-template check below ever
// passes a non-default rule — processFVGZones' own mitigation sweep (which
// sets fvg_zones.mitigated_at) always uses the default.
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

function isPriceInFVG(price, fvgRow) {
  return price >= fvgRow.bottom && price <= fvgRow.top;
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

// ── Phase 3 — Template chains T1/T2/T4 (FVG-entry gated) ─────
// Runs independently of user_sweep_configs — a user can enable a T1/T2/T4
// template on an LTF without separately subscribing to plain Sweep alerts
// on that same TF, so this pass is driven entirely by user_templates /
// chain_state, not the sweep-config symbolMap the main loop below builds.

async function getTelegramChat(db, userId) {
  const tg = await db.prepare(
    'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
  ).bind(userId).first();
  return tg?.chat_id ?? null;
}

function formatFvgEntryAlert(templateType, symbol, htf, ltf, direction, fvg, price, signalId) {
  const emoji    = direction === 'bullish' ? '🟢' : '🔴';
  const dirLabel = direction === 'bullish' ? 'BULL' : 'BEAR';
  const flow = templateType === 'T4'
    ? `LTF: ${ltf} Sweep → FVG Entry`
    : templateType === 'T2'
      ? `HTF: ${htf} EBP → LTF: ${ltf} Retracement FVG`
      : `HTF: ${htf} EBP → LTF: ${ltf} FVG Entry`;
  return [
    `🎯 ${templateType} Signal — ${symbol}`,
    flow,
    `Direction: ${emoji} ${dirLabel}`,
    `FVG Zone: ${fvg.bottom} – ${fvg.top}`,
    `Price: ${price}`,
    `Signal ID: ${signalId}`,
  ].join('\n');
}

// Returns the matching active FVG row, or null. T2 additionally requires
// the FVG to have formed inside the originating HTF EBP candle's body/window.
async function checkFvgEntryChain(env, chain, latestClose) {
  const { results: fvgs } = await env.DB.prepare(
    `SELECT * FROM fvg_zones WHERE symbol=? AND tf=? AND direction=? AND mitigated_at IS NULL AND expires_at > ?`
  ).bind(chain.symbol, chain.ltf, chain.direction, new Date().toISOString()).all();

  // fvg_rule lives on user_templates, not chain_state — look up by
  // user_id+asset_id+template (not htf+ltf: T4's chain_state.htf is always
  // '', which never matches the real htf value on its user_templates row).
  const tmplRow = await env.DB.prepare(
    `SELECT fvg_rule FROM user_templates WHERE user_id=? AND asset_id=? AND template=?`
  ).bind(chain.user_id, chain.asset_id, chain.template_type.toLowerCase()).first();
  const fvgRule = tmplRow?.fvg_rule || '50_percent';

  for (const fvg of fvgs ?? []) {
    if (chain.template_type === 'T2') {
      if (!(fvg.formed_at >= chain.htf_candle_open_time && fvg.formed_at <= chain.htf_candle_close_time)) continue;
      const bodyTop    = Math.max(chain.htf_candle_open, chain.htf_candle_close);
      const bodyBottom = Math.min(chain.htf_candle_open, chain.htf_candle_close);
      if (!(fvg.top <= bodyTop && fvg.bottom >= bodyBottom)) continue;
    }
    // Per-template mitigation check (independent of fvg_zones.mitigated_at,
    // which is always 50_percent-based) — an FVG this template's own rule
    // considers already mitigated is no longer a valid entry.
    const isMitigated = checkFVGMitigation({ close: latestClose }, fvg, fvgRule);
    if (isMitigated) continue;
    if (isPriceInFVG(latestClose, fvg)) return fvg;
  }
  return null;
}

async function processTemplateChains(tf, env, log) {
  // T4 Step 1 — sweep on this LTF creates a new chain when a user has an
  // active T4 template for this symbol+ltf. T4 has no HTF EBP trigger, so
  // this is driven by user_templates directly rather than the EBP flow
  // T1/T2/T3 use.
  const { results: t4Templates } = await env.DB.prepare(
    `SELECT ut.user_id, ut.asset_id, ut.bias_gate, ut.window_mins, ua.symbol FROM user_templates ut
     JOIN user_assets ua ON ut.asset_id = ua.id
     JOIN users u ON ut.user_id = u.id
     WHERE ut.template='t4' AND ut.enabled=1 AND ut.ltf=? AND u.active=1 AND ua.asset_type != 'nse'`
  ).bind(tf).all();

  for (const t of t4Templates ?? []) {
    try {
      const candles = await getCandlesFromCache(t.symbol, tf, env);
      if (!candles || candles.length < 2) continue;
      const sweep = detectSweep(candles);
      if (!sweep) continue;

      const biasGateEnabled = t.bias_gate !== 0; // default 1 = enabled
      if (biasGateEnabled) {
        const htf = BIAS_SOURCE.sweep[tf] ?? null;
        let bias = 'neutral';
        if (htf) {
          let htfCandles;
          if (htf === 'D') htfCandles = await getDailyCandlesFromCache(t.symbol, env);
          else if (htf === 'W') htfCandles = await getWeeklyCandlesFromCache(t.symbol, env);
          else htfCandles = await getCandlesFromCache(t.symbol, htf, env);
          if (htfCandles?.length >= 2) {
            const biasResult = calcTTradesBias({ bar1: htfCandles[0], bar2: htfCandles[1] });
            bias = biasResult.bias;
          }
        }
        if (bias !== sweep.direction) continue;
      }

      // Time-window dedup, matching isDuplicateAlert's intent — not just "is
      // one still pending" but "did one fire recently" (any state, including
      // complete). window_mins is T3's own field, reused here as the dedup
      // window since T4 has no other per-template timing config.
      const recentChain = await env.DB.prepare(`
        SELECT id FROM chain_state
        WHERE template_type = 'T4'
          AND user_id = ?
          AND symbol = ?
          AND direction = ?
          AND created_at > ?
        LIMIT 1
      `).bind(
        t.user_id,
        t.symbol,
        sweep.direction,
        new Date(Date.now() - (t.window_mins || 60) * 60 * 1000).toISOString()
      ).first();

      if (!recentChain) {
        await insertChain(env.DB, {
          templateType: 'T4', userId: t.user_id, assetId: t.asset_id, symbol: t.symbol,
          htf: '', ltf: tf, direction: sweep.direction, state: 'awaiting_fvg_entry',
          expiresAt: endOfUTCMonthISO(),
        });
        log(`[${t.symbol}] T4 chain created (${sweep.direction})`);
      }
    } catch (err) {
      console.error(`T4 step1 error ${t.symbol} ${tf}:`, err.message);
    }
  }

  // Step 2 (T1/T2) + Step 1-same-cycle-check (T4) — FVG-entry check, every
  // LTF cron cycle, for every active chain regardless of which
  // user_sweep_configs rows exist for that user.
  const { results: chains } = await env.DB.prepare(
    `SELECT * FROM chain_state WHERE template_type IN ('T1','T2','T4')
     AND state IN ('awaiting_fvg_entry','awaiting_retracement') AND ltf=? AND expires_at > ?`
  ).bind(tf, new Date().toISOString()).all();

  const candleCache = new Map();
  for (const chain of chains ?? []) {
    try {
      if (!candleCache.has(chain.symbol)) {
        candleCache.set(chain.symbol, await getCandlesFromCache(chain.symbol, tf, env));
      }
      const candles = candleCache.get(chain.symbol);
      if (!candles || candles.length < 1) continue;
      const latestClose = candles[0].close;

      const fvg = await checkFvgEntryChain(env, chain, latestClose);
      if (!fvg) continue;

      const signalId = await generateSignalId(env.DB, chain.template_type, chain.symbol);
      await completeFvgEntryChain(env.DB, chain.id, signalId, fvg.id);

      const chatId = await getTelegramChat(env.DB, chain.user_id);
      if (chatId) {
        const msg = formatFvgEntryAlert(chain.template_type, chain.symbol, chain.htf, chain.ltf, chain.direction, fvg, latestClose, signalId);
        await sendTelegramMessage(env.SHARED_BOT_TOKEN, chatId, msg);
      }

      const firedAt = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO signals (
          signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at,
          price_at_signal, session
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        signalId, chain.template_type, chain.symbol, chain.htf || null, chain.ltf,
        chain.direction, firedAt, latestClose, deriveSession(firedAt)
      ).run();

      log(`[${chain.symbol}] ${chain.template_type} chain complete → ${signalId}`);
    } catch (err) {
      console.error(`Template chain error ${chain.symbol} ${tf}:`, err.message);
    }
  }
}

// ── Main cron handler ─────────────────────────────────────────

export async function handleSweepCron(tf, env, debugLog = null) {
  const log = (msg) => { console.log(msg); if (debugLog) debugLog.push(msg); };
  log(`Sweep trigger → TF: ${tf}`);

  // M5 sweep support has been dropped (Watchdog migration) — M15 is now the
  // smallest tick, so the periodic cleanup that used to piggyback on M5 runs
  // here instead. Key-state / api_call_log cleanup is gone too — Sweep
  // Worker no longer touches Twelve Data keys or api_call_log at all;
  // that's Watchdog's exclusive concern now.
  if (tf === 'M15') {
    await cleanupExpiredFVGs(env.DB);
    await cleanupExpiredChains(env.DB);
    log('Cleaned up expired FVGs and chains');
  }

  // Phase 3 — T1/T2/T4 chains, decoupled from the sweep-config-driven loop
  // below (see processTemplateChains comment for why).
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
      // Symbol-level (not per-user) bias, used only for the T3 signals
      // table record below and the log line — that table has no per-user
      // concept.
      const htfBias = defaultBiasTF ? (biasByTF.get(defaultBiasTF) ?? 'neutral') : 'neutral';

      // FVG Phase 1 + Swing/MSS Phase 1.5+2 — candles are newest-first; need oldest-first
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

            // T3 step 3 — MSS completes the chain. MSS direction must match
            // chain direction (bull chain expects bull MSS).
            const mssChains = await getChains(env.DB, {
              templateTypes: 'T3', state: 'awaiting_mss', symbol,
              direction: mssResult.direction, userId: row.user_id,
            });
            for (const chain of mssChains) {
              if (chain.ltf !== tf) continue;

              // Signal ID was assigned at Step 1 (chain initiation in
              // ebp-worker.js) and carried on chain_state.step1_signal_id —
              // reuse it, do not generate a new one (IM-4).
              const signalId = chain.step1_signal_id;
              const firedAt  = new Date().toISOString();
              // price_at_signal: detectMSS() returns {direction, level, candle_time} —
              // no close field — so the actual MSS-triggering candle's close comes
              // from `candles` (newest-first, fetched above), not mssResult itself.
              // htf_bias: the bias for BIAS_SOURCE.sweep[tf] (this LTF's own bias
              // gating), not a fresh lookup against chain.htf specifically —
              // may differ from the chain's original EBP HTF in some configs.
              await env.DB.prepare(`
                INSERT INTO signals (
                  signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at,
                  price_at_signal, htf_bias, session
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                signalId, 'T3', symbol, chain.htf, tf,
                mssResult.direction, firedAt,
                candles[0].close ?? null,
                htfBias ?? null,
                deriveSession(firedAt)
              ).run();

              const t3Msg = formatT3Alert(
                symbol, chain.htf, tf, mssResult.direction,
                deriveSession(firedAt), candles[0].close ?? null,
                signalId, 3
              );
              await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, t3Msg);
              await env.DB.prepare(`
                INSERT INTO alert_history
                (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
                VALUES (?,?,?,?,?,?,?,?,'t3')
              `).bind(
                crypto.randomUUID(), row.user_id, symbol,
                `${chain.htf}+${tf}`,
                mssResult.direction, effectiveBias, mssResult.candle_time, new Date().toISOString()
              ).run();
              await completeT3Chain(env.DB, chain.id);
            }
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

        // T3 step 2 — sweep advances an active chain. Same-direction match
        // (sweep.direction === chain.direction): this codebase names a
        // sweep by its resulting bias, not the side swept, so a bull chain
        // (direction='bullish') is advanced by a bullish sweep (= a sweep
        // of lows, closed back above) — matching the spec's own worked
        // example even though its prose calls this "opposite".
        const sweepChains = await getChains(env.DB, {
          templateTypes: 'T3', state: 'awaiting_sweep', symbol,
          direction: sweep.direction, userId: row.user_id,
        });
        for (const chain of sweepChains) {
          if (chain.ltf !== tf) continue;

          const tmplRow = await env.DB.prepare(
            `SELECT step3_enabled FROM user_templates WHERE user_id=? AND asset_id=? AND template='t3' AND htf=? AND ltf=?`
          ).bind(chain.user_id, chain.asset_id, chain.htf, chain.ltf).first();
          const step3Enabled = (tmplRow?.step3_enabled ?? 1) !== 0; // default 1 = enabled

          if (!step3Enabled) {
            // MSS skipped by config — complete the chain right here at the
            // sweep, same signals/alert_history bookkeeping the normal
            // Step-3/MSS completion does, just fired one step early.
            const firedAt = new Date().toISOString();
            await env.DB.prepare(`
              INSERT INTO signals (
                signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at,
                price_at_signal, session
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              chain.step1_signal_id, 'T3', symbol, chain.htf, tf,
              sweep.direction, firedAt, sweep.closedInsideLevel ?? null, deriveSession(firedAt)
            ).run();

            const step2CompleteMsg = formatT3Step2CompleteAlert(
              symbol, chain.htf, tf, sweep.direction,
              deriveSession(firedAt), chain.step1_signal_id
            );
            await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, step2CompleteMsg);

            await env.DB.prepare(`
              INSERT INTO alert_history
              (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
              VALUES (?,?,?,?,?,?,?,?,'t3')
            `).bind(
              crypto.randomUUID(), row.user_id, symbol, `${chain.htf}+${tf}`,
              sweep.direction, effectiveBias, sweep.candleTime, new Date().toISOString()
            ).run();

            await completeT3Chain(env.DB, chain.id);
          } else {
            await advanceT3Chain(env.DB, chain.id); // existing: set awaiting_mss

            const step2Msg = formatT3Alert(
              symbol, chain.htf, tf, sweep.direction,
              deriveSession(new Date().toISOString()), sweep.closedInsideLevel ?? null,
              chain.step1_signal_id, 2
            );
            await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, step2Msg);
          }
        }
      }

      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`Error processing ${symbol} on ${tf}:`, err.message);
    }
  }

  console.log(`Sweep cron complete for ${tf}`);
}

// ── Forex/Crypto SMA Cloud (2026-08-05) ──────────────────────────
// Runs in Sweep Worker via POST /cron/sma. Same three-signal design as the
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

const FOREX_SMA_HTF_OPTIONS = {
  'M15': ['4H'],
  'M30': ['4H'],
  '1H':  ['4H', 'D'],
  '4H':  ['D'],
};

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
    crypto.randomUUID(), userId, symbol, timeframe, direction, trendBias ?? 'neutral', candleTime, new Date().toISOString(), alertType
  ).run();
  return true;
}

// Main forex/crypto SMA Cloud cron handler.
export async function handleForexSmaCron(tf, env, debugLog = null) {
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