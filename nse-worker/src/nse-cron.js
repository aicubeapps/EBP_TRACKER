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
  for (let i = timestamps.length - 1; i >= 0 && candles.length < 10; i--) {
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

async function fetchNseCandles(symbol, tf, env) {
  const upstoxKey = await env.DB.prepare(
    "SELECT key_value FROM api_keys WHERE source='upstox' AND enabled=1 LIMIT 1"
  ).first();

  if (upstoxKey) {
    try {
      const candles = await fetchUpstoxNse(symbol, tf, upstoxKey.key_value);
      if (candles && candles.length >= 3) return candles;
    } catch (e) {
      console.warn(`[NSE] Upstox failed ${symbol} ${tf}, falling back to Yahoo: ${e.message}`);
    }
  }

  try {
    return await fetchYahooFinanceNse(symbol, tf);
  } catch (e) {
    console.error(`[NSE] Yahoo failed ${symbol} ${tf}: ${e.message}`);
    return null;
  }
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

// ── Swing state + MSS — copied verbatim from worker/src/ebp-worker.js ──
// Uses the shared swing_state table — same rows the EBP/Sweep Workers
// write to, keyed by (symbol, timeframe). NSE timeframes (M1/M30) don't
// collide with forex/crypto TFs on the same symbols since symbols differ
// (RELIANCE.NS vs EUR/USD), so sharing the table is safe.
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
    AND ua.active=1 AND u.active=1
  `).bind(tf).all();

  const { results: sweepRows } = await env.DB.prepare(`
    SELECT sc.id as config_id, sc.alert_mode,
           ua.id as asset_id, ua.symbol,
           u.id as user_id, u.nse_tf_access
    FROM user_sweep_configs sc
    JOIN user_assets ua ON sc.asset_id = ua.id
    JOIN users u ON sc.user_id = u.id
    WHERE ua.asset_type='nse' AND sc.timeframe=? AND sc.enabled=1
    AND ua.active=1 AND u.active=1
  `).bind(tf).all();

  const symbolMap = new Map(); // symbol -> { ebp: [rows], sweep: [rows] }
  for (const row of (ebpRows ?? [])) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, { ebp: [], sweep: [] });
    symbolMap.get(row.symbol).ebp.push(row);
  }
  for (const row of (sweepRows ?? [])) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, { ebp: [], sweep: [] });
    symbolMap.get(row.symbol).sweep.push(row);
  }

  if (symbolMap.size === 0) {
    return { ok: true, symbolsProcessed: 0 };
  }

  const biasTF = NSE_BIAS_SOURCE.ebp[tf] ?? null; // identical map for ebp/sweep per spec

  for (const [symbol, { ebp: ebpUserRows, sweep: sweepUserRows }] of symbolMap) {
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
        mssResult = await updateSwingState(env.DB, symbol, tf, oldestFirst);
      }

      const ebpResult   = detectEBP(candles);
      const sweepResult = detectSweep(candles);

      if (mssResult) {
        const signalId = await generateNseSignalId(env, symbol);
        await env.DB.prepare(`
          INSERT INTO signals (signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at, traded)
          VALUES (?,?,?,?,?,?,?,0)
        `).bind(signalId, 'NSE_MSS', symbol, biasTF, tf, mssResult.direction, new Date().toISOString()).run();

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
        await env.DB.prepare(`
          INSERT INTO signals (signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at, traded)
          VALUES (?,?,?,?,?,?,?,0)
        `).bind(signalId, 'NSE_EBP', symbol, biasTF, tf, ebpResult.direction, new Date().toISOString()).run();

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
        await env.DB.prepare(`
          INSERT INTO signals (signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at, traded)
          VALUES (?,?,?,?,?,?,?,0)
        `).bind(signalId, 'NSE_SWEEP', symbol, biasTF, tf, sweepResult.direction, new Date().toISOString()).run();

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

      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[NSE] cron error ${symbol} ${tf}: ${err.message}`);
    }
  }

  return { ok: true, symbolsProcessed: symbolMap.size };
}
