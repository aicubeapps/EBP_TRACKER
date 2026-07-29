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

function getHTFForSweepTF(tf) {
  const map = { 'M15': '1H', 'M30': '4H', '1H': 'D', '4H': 'W' };
  return map[tf] ?? null;
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

// ── Phase I — Signal IDs (per-template global counter, A001→Z999) ──
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

function formatT3Alert(symbol, direction, htfTf, ltfTf, htfBar, ltfBar, mssBar, signalId) {
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
    `🔗 Signal ID: ${signalId}`,
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
  if (age > 2 * intervalMs[tf]) {
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
// Watchdog's synthesised tables, not candle_cache.
async function getDailyCandlesFromCache(symbol, env) {
  const { results } = await env.DB.prepare(
    'SELECT date_ny, open, high, low, close FROM daily_candle_cache WHERE symbol = ? ORDER BY date_ny DESC LIMIT 5'
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

function getCandleDirection(candle, priorDirection) {
  if (candle.close > candle.open) return 'bullish';
  if (candle.close < candle.open) return 'bearish';
  return priorDirection;
}

async function updateSwingState(db, symbol, timeframe, candles) {
  try {
  console.log(`[SWING] Processing ${symbol} ${timeframe}`);
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
  } catch (e) {
    console.error(`[SWING] ERROR ${symbol} ${timeframe}: ${e.message}\n${e.stack}`);
    return null;
  }
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

// ── FVG Engine (Phase 1, inlined) ────────────────────────────

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
  try {
  console.log(`[FVG] Processing ${symbol} ${timeframe}`);
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
  } catch (e) {
    console.error(`[FVG] ERROR ${symbol} ${timeframe}: ${e.message}\n${e.stack}`);
  }
}

async function cleanupExpiredFVGs(db) {
  const now = Date.now();
  await db.prepare(`UPDATE detected_fvgs SET mitigated=1, mitigated_at=? WHERE mitigated=0 AND expires_at<?`)
    .bind(now, now).run();
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
        await processFVGs(env.DB, symbol, tf, oldestFirst, candles[0]);

        const mssResult = await updateSwingState(env.DB, symbol, tf, oldestFirst);
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

            const msg = formatMSSAlert(symbol, tf, mssResult, effectiveBias, getHTFBiasLabel(userBiasTF));
            await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);

            await env.DB.prepare(
              `INSERT INTO alert_history
               (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
               VALUES (?,?,?,?,?,?,?,?,'mss')`
            ).bind(
              crypto.randomUUID(), row.user_id, symbol, tf,
              mssResult.direction, effectiveBias, mssResult.candle_time, Date.now()
            ).run();

            // T3 step 3 — MSS completes the chain
            const mssChains = await getActiveChains(env.DB, row.user_id, symbol, 't3', mssResult.direction, 3);
            for (const chain of mssChains) {
              if (chain.ltf !== tf) continue;

              const signalId = await generateSignalId(env.DB, 'T3', symbol);
              const firedAt  = new Date().toISOString();
              // price_at_signal: detectMSS() returns {direction, level, candle_time} —
              // no close field — so the actual MSS-triggering candle's close comes
              // from `candles` (newest-first, fetched above), not mssResult itself.
              // htf_bias: the bias for BIAS_SOURCE.sweep[tf] (this LTF's own bias
              // gating), not a fresh lookup against chain.htf_tf specifically —
              // may differ from the chain's original EBP HTF in some configs.
              // htf_close: chain_state has no close-price column and
              // initiateT3Chain never sets one — always null for T3.
              await env.DB.prepare(`
                INSERT INTO signals (
                  signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at,
                  price_at_signal, htf_bias, session, htf_close
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                signalId, 'T3', symbol, chain.htf_tf, tf,
                mssResult.direction, firedAt,
                candles[0].close ?? null,
                htfBias ?? null,
                deriveSession(firedAt),
                chain.htf_close ?? null
              ).run();

              const t3Msg = formatT3Alert(
                symbol, mssResult.direction,
                chain.htf_tf, tf,
                { time: chain.htf_signal_time },
                { time: chain.ltf_sweep_time },
                { time: mssResult.candle_time },
                signalId
              );
              await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, t3Msg);
              await env.DB.prepare(`
                INSERT INTO alert_history
                (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
                VALUES (?,?,?,?,?,?,?,?,'t3')
              `).bind(
                crypto.randomUUID(), row.user_id, symbol,
                `${chain.htf_tf}+${tf}`,
                mssResult.direction, effectiveBias, mssResult.candle_time, Date.now()
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
          sweep.direction, effectiveBias, sweep.candleTime, Date.now()
        ).run();

        // T3 step 2 — sweep advances an active chain
        const sweepChains = await getActiveChains(env.DB, row.user_id, symbol, 't3', sweep.direction, 2);
        for (const chain of sweepChains) {
          if (chain.ltf !== tf) continue;
          await advanceT3Chain(env.DB, chain.id, sweep.candleTime);
        }
      }

      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`Error processing ${symbol} on ${tf}:`, err.message);
    }
  }

  console.log(`Sweep cron complete for ${tf}`);
}