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
    if (base.length <= 5 && quote === 'USD') return `${base}-USD`;
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

async function fetchTwelveData(symbol, tf, apiKey, outputSize = 3) {
  const interval = tfToTwelveInterval(tf);
  const params   = new URLSearchParams({
    symbol, interval,
    outputsize: String(outputSize),
    apikey: apiKey,
    ...(tf === 'D' ? { timezone: 'America/New_York' } : {}),
  });
  const res  = await fetch(`https://api.twelvedata.com/time_series?${params}`);
  const data = await res.json();
  if (data.status === 'error' || !data.values) {
    throw new Error(`Twelve Data: ${data.message ?? 'no values'}`);
  }
  return data.values.map(v => ({
    open:  parseFloat(v.open),
    high:  parseFloat(v.high),
    low:   parseFloat(v.low),
    close: parseFloat(v.close),
    time:  new Date(v.datetime).getTime(),
  }));
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

async function fetchCandles(symbol, tf, apiKey) {
  try {
    const c = await fetchTwelveData(symbol, tf, apiKey, 3);
    if (c.length >= 2) return c;
    throw new Error('Insufficient candles');
  } catch (e) {
    console.warn(`Twelve Data failed ${symbol} ${tf}: ${e.message}`);
    try {
      const c = await fetchYahooFinance(symbol, tf, 3);
      if (c.length >= 2) return c;
      throw new Error('Insufficient candles');
    } catch (e2) {
      console.error(`Both sources failed ${symbol} ${tf}: ${e2.message}`);
      return null;
    }
  }
}

async function validateSymbol(symbol, apiKey) {
  // Yahoo Finance only — preserves Twelve Data quota for candle fetching
  try {
    const yahooSymbol = toYahooSymbol(symbol);
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + yahooSymbol + '?interval=1d&range=5d';
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (result?.meta?.symbol) return { valid: true, source: 'yahoo' };
  } catch (e) {
    console.warn('Yahoo validation failed:', e.message);
  }
  return { valid: true, source: 'fallback' };
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

function getHTFLabel(tf) {
  const map = { 'M15': '4H', '1H': 'Daily', '4H': 'Weekly', 'D': 'Weekly', 'W': 'Raw' };
  return map[tf] ?? 'HTF';
}

function fmtNY(ts) {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit',
    month: 'short', day: 'numeric',
  });
}

function formatEBPAlert({ symbol, tf, direction, candleTime, trendBias, trendAligned, sweptLevel, closedLevel }) {
  const emoji     = direction === 'bullish' ? '🟢' : '🔴';
  const label     = direction === 'bullish' ? 'BULLISH EBP' : 'BEARISH EBP';
  const alignMark = trendAligned ? '✅' : '⚠️ No Trend Filter';
  const swept     = direction === 'bullish' ? 'Low swept' : 'High swept';
  const closed    = direction === 'bullish' ? 'Closed above body' : 'Closed below body';
  return `${emoji} <b>${label} — ${symbol}</b>
⏱ Timeframe: ${tf}
🕐 Candle: ${fmtNY(candleTime)} NY
📊 Trend: ${trendBias} (${getHTFLabel(tf)} bias) ${alignMark}
━━━━━━━━━━━━━━
${swept}: ${sweptLevel}
${closed}: ${closedLevel}
━━━━━━━━━━━━━━
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
📊 Trend: ${htfBias} (${htfLabelStr} bias) ${aligned ? '✅' : '⚠️'}
━━━━━━━━━━━━━━
${swingLabel}: ${mss.level?.toFixed(5)}
━━━━━━━━━━━━━━
<i>EBP Tracker</i>`;
}

// ============================================================
// DST Helper
// ============================================================
function isUSDST(date = new Date()) {
  const y  = date.getUTCFullYear();
  const m3 = new Date(Date.UTC(y, 2, 1));
  const dstStart = new Date(Date.UTC(y, 2, 1 + (7 - m3.getUTCDay()) % 7 + 7));
  const m11 = new Date(Date.UTC(y, 10, 1));
  const dstEnd   = new Date(Date.UTC(y, 10, 1 + (7 - m11.getUTCDay()) % 7));
  return date >= dstStart && date < dstEnd;
}

function getNYCloseUTCHour(date = new Date()) {
  return isUSDST(date) ? 21 : 22;
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

// ============================================================
// Cron Handler
// ============================================================
async function handleCron(cronExpr, env) {
  const now  = new Date();
  const hour = now.getUTCHours();
  const min  = now.getUTCMinutes();
  const nyCloseHour = getNYCloseUTCHour(now);
  const isNYClose   = hour === nyCloseHour && min === 0;
  const isFriday    = now.getUTCDay() === 5;
  const isWeekday   = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;

  let tf;
  if (isNYClose && isFriday)       tf = 'W';
  else if (isNYClose && isWeekday) tf = 'D';
  else if (min === 0 && hour % 4 === 0) tf = '4H';
  else if (min === 0)              tf = '1H';
  else                             tf = 'M15';

  console.log(`Cron ${cronExpr} → TF: ${tf}`);

  const rows = await env.DB.prepare(`
    SELECT ua.id, ua.symbol, ua.timeframes, ua.ebp_alert_mode,
           ua.combined_enabled, ua.combined_pairs, ua.combined_window_mins,
           u.id as user_id
    FROM user_assets ua
    JOIN users u ON u.id = ua.user_id
    WHERE ua.active = 1 AND u.active = 1
  `).all();

  const filtered = (rows.results ?? []).filter(r =>
    r.timeframes.split(',').map(t => t.trim()).includes(tf)
  );
  if (!filtered.length) return;

  const symbolMap = new Map();
  for (const row of filtered) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, []);
    symbolMap.get(row.symbol).push(row);
  }

  const htfTF = getHTFForTF(tf);

  for (const [symbol, userRows] of symbolMap) {
    try {
      const candles = await fetchCandles(symbol, tf, env.TWELVE_DATA_API_KEY);
      if (!candles || candles.length < 2) continue;

      let htfBias = 'neutral';
      if (htfTF) {
        const htfCandles = await fetchCandles(symbol, htfTF, env.TWELVE_DATA_API_KEY);
        if (htfCandles?.length >= 3) {
          const r = calcTTradesBias({ bar1: htfCandles[1], bar2: htfCandles[2] });
          htfBias = r.bias;
        }
      }

      await updateCandleCache(env.DB, symbol, tf, candles);

      // FVG Phase 1 — candles are newest-first; processFVGs needs oldest-first
      if (candles.length >= 3) {
        const oldestFirst = [candles[2], candles[1], candles[0]];
        await processFVGs(env.DB, symbol, tf, oldestFirst, candles[0]);

        // Phase 1.5 + 2 — Swing state + MSS
        const mssResult = await updateSwingState(env.DB, symbol, tf, oldestFirst);
        if (mssResult) {
          const htfLabelStr = getHTFLabel(tf);
          for (const row of userRows) {
            const alertMode  = row.ebp_alert_mode ?? 'aligned';
            const shouldAlert = alertMode === 'all' || mssResult.direction === htfBias || htfBias === 'neutral';
            if (!shouldAlert) continue;

            const tg = await env.DB.prepare(
              'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
            ).bind(row.user_id).first();
            if (!tg?.chat_id) continue;

            const msg = formatMSSAlert(symbol, tf, mssResult, htfBias, htfLabelStr);
            await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);

            await env.DB.prepare(
              `INSERT INTO alert_history
               (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
               VALUES (?,?,?,?,?,?,?,?,'mss')`
            ).bind(
              crypto.randomUUID(), row.user_id, symbol, tf,
              mssResult.direction, htfBias, mssResult.candle_time, Date.now()
            ).run();
          }
        }
      }

      const ebp = detectEBP(candles);
      if (!ebp) continue;

      for (const row of userRows) {
        const alertMode    = row.ebp_alert_mode ?? 'aligned';
        const trendAligned = ebp.direction === htfBias;
        if (alertMode === 'aligned' && !trendAligned) continue;

        const tg = await env.DB.prepare(
          'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
        ).bind(row.user_id).first();
        if (!tg?.chat_id) continue;

        const msg = formatEBPAlert({
          symbol, tf,
          direction:   ebp.direction,
          candleTime:  ebp.candleTime,
          trendBias:   htfBias,
          trendAligned,
          sweptLevel:  ebp.sweptLevel?.toFixed(5),
          closedLevel: ebp.closedLevel?.toFixed(5),
        });

        await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);

        await env.DB.prepare(`
          INSERT INTO alert_history
          (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
          VALUES (?,?,?,?,?,?,?,?,'ebp')
        `).bind(
          crypto.randomUUID(), row.user_id, symbol, tf,
          ebp.direction, htfBias, ebp.candleTime, Date.now()
        ).run();

        if (row.combined_enabled) {
          const windowMs  = (row.combined_window_mins ?? 60) * 60 * 1000;
          await env.DB.prepare(`
            INSERT OR REPLACE INTO pending_signals
            (id, user_id, symbol, direction, signal_type, timeframe, fired_at, expires_at, consumed_pairs)
            VALUES (?,?,?,?,'ebp',?,?,?,'[]')
          `).bind(
            crypto.randomUUID(), row.user_id, symbol,
            ebp.direction, tf, Date.now(), Date.now() + windowMs
          ).run();
        }
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`Error ${symbol} ${tf}:`, err.message);
    }
  }
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
    INSERT INTO users (id, email, name, created_at, expires_at)
    VALUES (?,?,?,?,?)
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
  const user = await getOrCreateUser(env.DB, clerkUser);
  return json(user, 200, origin);
});

router.get('/user/assets', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);

  const assets = await env.DB.prepare(
    'SELECT * FROM user_assets WHERE user_id = ? AND active = 1 ORDER BY added_at ASC'
  ).bind(clerkUser.id).all();

  const enriched = await Promise.all((assets.results ?? []).map(async asset => {
    const tfs    = asset.timeframes.split(',').map(t => t.trim());
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

  const count = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND active = 1'
  ).bind(clerkUser.id).first();
  if (count.cnt >= user.asset_limit) {
    return json({ error: 'Asset slot limit reached. Upgrade to add more.' }, 403, origin);
  }

  const symbolStr = String(body.symbol ?? '').toUpperCase().trim();
  if (!symbolStr) {
    return json({ error: 'Symbol is required.' }, 400, origin);
  }
  const existing = await env.DB.prepare(
    'SELECT id FROM user_assets WHERE user_id = ? AND symbol = ? AND active = 1'
  ).bind(clerkUser.id, symbolStr).first();
  if (existing) {
    return json({ error: 'Asset already in your list.' }, 400, origin);
  }

  const validation = await validateSymbol(body.symbol, env.TWELVE_DATA_API_KEY);
  if (!validation.valid) {
    return json({ error: 'Symbol not found on any data source.' }, 400, origin);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO user_assets (id, user_id, symbol, display_name, asset_type, added_at)
    VALUES (?,?,?,?,?,?)
  `).bind(id, clerkUser.id, symbolStr,
    body.displayName ?? symbolStr,
    body.assetType ?? 'forex', Date.now()).run();

  return json({ id, symbol: body.symbol }, 201, origin);
});

router.delete('/user/assets/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  await env.DB.prepare(
    'UPDATE user_assets SET active = 0 WHERE id = ? AND user_id = ?'
  ).bind(params.id, clerkUser.id).run();
  return json({ success: true }, 200, origin);
});

router.patch('/user/assets/:id/ebp', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const body = await req.json();
  await env.DB.prepare(
    'UPDATE user_assets SET timeframes = ?, ebp_alert_mode = ? WHERE id = ? AND user_id = ?'
  ).bind(body.timeframes, body.alertMode, params.id, clerkUser.id).run();
  return json({ success: true }, 200, origin);
});

router.patch('/user/assets/:id/sweep', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const body = await req.json();
  await env.DB.prepare(
    'UPDATE user_assets SET sweep_enabled = ?, sweep_timeframes = ?, sweep_alert_mode = ? WHERE id = ? AND user_id = ?'
  ).bind(
    body.enabled ? 1 : 0,
    body.timeframes ?? '4H,1H,M15',
    body.alertMode ?? 'aligned',
    params.id, clerkUser.id
  ).run();
  return json({ success: true }, 200, origin);
});

router.patch('/user/assets/:id/combined', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const body = await req.json();
  await env.DB.prepare(`
    UPDATE user_assets
    SET combined_enabled = ?, combined_pairs = ?, combined_window_mins = ?
    WHERE id = ? AND user_id = ?
  `).bind(
    body.enabled ? 1 : 0,
    JSON.stringify(body.pairs ?? []),
    body.windowMins ?? 60,
    params.id, clerkUser.id
  ).run();
  return json({ success: true }, 200, origin);
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
    WHERE ua.user_id = ? AND ua.active = 1
    ORDER BY ua.added_at ASC
  `).bind(clerkUser.id).all();
  return json(assets.results ?? [], 200, origin);
});

// ── Alerts ────────────────────────────────────────────────────

router.get('/alerts/history', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const url   = new URL(req.url);
  const type  = url.searchParams.get('type') ?? 'all';
  const limit = parseInt(url.searchParams.get('limit') ?? '100');
  let query   = 'SELECT * FROM alert_history WHERE user_id = ?';
  const params = [clerkUser.id];
  if (type !== 'all') { query += ' AND alert_type = ?'; params.push(type); }
  query += ' ORDER BY fired_at DESC LIMIT ?';
  params.push(limit);
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

// ── Payments ──────────────────────────────────────────────────

router.post('/payment/submit', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const body        = await req.json();
  const tierAmounts = { coffee: 99, beer: 249, wine: 499 };
  const amount      = tierAmounts[body.tier];
  if (!amount) return json({ error: 'Invalid tier' }, 400, origin);

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO payment_log (id, user_id, tier, amount_inr, upi_ref, submitted_at)
    VALUES (?,?,?,?,?,?)
  `).bind(id, clerkUser.id, body.tier, amount, body.upiRef ?? '', Date.now()).run();

  if (env.DEVELOPER_TELEGRAM_CHAT_ID && env.SHARED_BOT_TOKEN) {
    await sendTelegramMessage(env.SHARED_BOT_TOKEN, env.DEVELOPER_TELEGRAM_CHAT_ID,
      `💰 <b>Payment pending</b>\nUser: ${clerkUser.email}\nTier: ${body.tier}\nAmount: ₹${amount}\nUPI Ref: ${body.upiRef ?? 'not provided'}\nID: ${id}`
    ).catch(() => {});
  }

  return json({ id, status: 'pending' }, 201, origin);
});

router.get('/payment/status', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  const payments = await env.DB.prepare(
    'SELECT * FROM payment_log WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 5'
  ).bind(clerkUser.id).all();
  return json(payments.results ?? [], 200, origin);
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
      (SELECT COUNT(*) FROM user_assets WHERE user_id = u.id AND active = 1) as asset_count,
      (SELECT COUNT(*) FROM alert_history WHERE user_id = u.id) as alert_count,
      (SELECT verified FROM user_telegram WHERE user_id = u.id) as telegram_verified
    FROM users u ORDER BY u.created_at DESC
  `).all();
  return json(users.results ?? [], 200, origin);
});

router.get('/admin/payments', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const payments = await env.DB.prepare(`
    SELECT p.*, u.email, u.name FROM payment_log p
    JOIN users u ON u.id = p.user_id
    ORDER BY p.submitted_at DESC
  `).all();
  return json(payments.results ?? [], 200, origin);
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

router.post('/admin/approve/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);

  const payment = await env.DB.prepare('SELECT * FROM payment_log WHERE id = ?').bind(params.id).first();
  if (!payment) return json({ error: 'Not found' }, 404, origin);

  const tierLimits = { coffee: 5, beer: 8, wine: 13 };
  const tierCfg    = await env.DB.prepare('SELECT asset_limit FROM tier_config WHERE tier = ?').bind(payment.tier).first();
  const newLimit   = tierCfg?.asset_limit ?? tierLimits[payment.tier] ?? 3;
  const newExpiry  = Date.now() + 30 * 24 * 60 * 60 * 1000;

  await env.DB.prepare(
    'UPDATE users SET plan = ?, asset_limit = ?, expires_at = ?, active = 1 WHERE id = ?'
  ).bind(payment.tier, newLimit, newExpiry, payment.user_id).run();

  await env.DB.prepare(
    "UPDATE payment_log SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?"
  ).bind(Date.now(), clerkUser.id, params.id).run();

  const tg = await env.DB.prepare(
    'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
  ).bind(payment.user_id).first();
  if (tg?.chat_id) {
    const emoji = { coffee: '☕', beer: '🍺', wine: '🍷' }[payment.tier] ?? '✅';
    await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id,
      `${emoji} <b>Payment approved!</b>\n\nYour ${payment.tier} tier is now active. You have ${newLimit} asset slots for the next 30 days.`
    ).catch(() => {});
  }

  return json({ success: true }, 200, origin);
});

router.post('/admin/reject/:id', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  await env.DB.prepare(
    "UPDATE payment_log SET status = 'rejected' WHERE id = ?"
  ).bind(params.id).run();
  return json({ success: true }, 200, origin);
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

router.get('/admin/tiers', async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const tiers = await env.DB.prepare(
    'SELECT * FROM tier_config ORDER BY price_inr ASC'
  ).all();
  return json(tiers.results ?? [], 200, origin);
});

router.patch('/admin/tiers/:tier', async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? 'Unauthorized' }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: 'Access denied' }, 403, origin);
  const body = await req.json();
  await env.DB.prepare(`
    INSERT INTO tier_config (tier, label, emoji, price_inr, asset_limit, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tier) DO UPDATE SET
      price_inr = excluded.price_inr,
      asset_limit = excluded.asset_limit,
      updated_at = excluded.updated_at
  `).bind(
    params.tier,
    body.label ?? params.tier,
    body.emoji ?? '☕',
    body.price_inr,
    body.asset_limit,
    Date.now()
  ).run();
  return json({ success: true }, 200, origin);
});

// ── Public tier pricing ─────────────────────────────────────

router.get('/tiers', async (req, env) => {
  const { origin } = req._ctx;
  const tiers = await env.DB.prepare(
    'SELECT tier, label, emoji, price_inr, asset_limit FROM tier_config ORDER BY price_inr ASC'
  ).all();
  if (!tiers.results?.length) {
    return json([
      { tier: 'coffee', label: 'Coffee', emoji: '☕', price_inr: 99,  asset_limit: 5  },
      { tier: 'beer',   label: 'Beer',   emoji: '🍺', price_inr: 249, asset_limit: 8  },
      { tier: 'wine',   label: 'Wine',   emoji: '🍷', price_inr: 499, asset_limit: 13 },
    ], 200, origin);
  }
  return json(tiers.results, 200, origin);
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
    const origin = getOrigin(request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url      = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method   = request.method;

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

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event.cron, env));
  },
};
