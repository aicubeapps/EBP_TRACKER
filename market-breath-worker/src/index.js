// ============================================================
// Market Breath Worker — Breadth / DXY / Synthesis / Digest
// Zero Twelve Data dependency — Yahoo Finance only.
// Forked from watchdog-worker; zero dependencies, pure CF runtime.
//
// Routes:
//   GET  /health                 — liveness check
//   POST /health/watchdog-check  — external watchdog heartbeat (moved from
//                                  ebp-watchdog 2026-08-15; see
//                                  handleWatchdogHealthCheck below)
//   POST /cron/breadth-fetch     — Yahoo breadth + DXY synthesis (hourly)
//   POST /cron/daily-digest      — EOD operations report via Telegram
//   POST /cron/prune             — Saturday-only DB retention cleanup
//
// All POST routes secured by X-Cron-Secret (cron-job.org triggers).
// DB retention (dxy_candle_cache, watchdog_log) moved here from the
// per-hour breadth-fetch run; now fires once weekly on Saturday.
// ============================================================

// ============================================================
// JSON helper
// ============================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================
// Watchdog Telegram alerts (admin/developer-only — uses the same
// WATCHDOG_BOT_TOKEN/WATCHDOG_ADMIN_CHAT_ID as ebp-watchdog)
// ============================================================

// logWatchdog() only ever receives a D1 handle (db), not the full env.
// HTTP route handlers set _watchdogAlertEnv = env at their entry so that
// logWatchdog() can fire sendWatchdogAlert() for errors/warnings without
// needing env threaded through every call site.
let _watchdogAlertEnv = null;

// Dedup guard for POST /cron/daily-digest — cron-job.org calls this route
// with no time gate of its own, so this worker instance tracks the NY
// calendar date the digest last fired for and refuses a second send on
// the same date. Module-level, same persistence-within-instance caveat as
// _watchdogAlertEnv above.
let lastDigestNYDate = null;

async function sendWatchdogAlert(env, message) {
  try {
    await fetch(`https://api.telegram.org/bot${env.WATCHDOG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.WATCHDOG_ADMIN_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    // swallow — Telegram failure must never crash this worker
  }
}

// ============================================================
// Symbol pools
// ============================================================

// Same 29 pairs as MAJOR_PAIRS in worker/src/ebp-worker.js —
// copied verbatim (no imports — zero-dependency rule).
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
  ['CAD/CHF', 'CAD', 'CHF'], ['USD/SEK', 'USD', 'SEK'],
];
const BREADTH_SYMBOLS = MAJOR_PAIRS.map(([pair]) => pair);

// Only symbols with at least one enabled EBP or Sweep config.
async function getSignalSymbols(db) {
  const { results } = await db.prepare(`
    SELECT DISTINCT ua.symbol
    FROM user_assets ua
    WHERE ua.asset_type IN ('forex','crypto','commodity')
    AND (
      EXISTS (
        SELECT 1 FROM user_ebp_configs ec
        WHERE ec.asset_id = ua.id AND ec.enabled = 1
      )
      OR EXISTS (
        SELECT 1 FROM user_sweep_configs sc
        WHERE sc.asset_id = ua.id AND sc.enabled = 1
      )
    )
  `).all();
  return (results ?? []).map(r => r.symbol);
}

// ============================================================
// TF constants
// ============================================================

// Forex 4H candles align to NY trading-day boundary (17:00 NY).
const NY_4H_BOUNDARIES = [17, 21, 1, 5, 9, 13];

// Copied verbatim from ebp-worker.js — used by getClosedCandles.
const INTERVAL_MS = {
  'M5':  5  * 60 * 1000,
  'M15': 15 * 60 * 1000,
  'M30': 30 * 60 * 1000,
  '1H':  60 * 60 * 1000,
  '4H':  4  * 60 * 60 * 1000,
  'D':   24 * 60 * 60 * 1000,
  'W':   7  * 24 * 60 * 60 * 1000,
};

// Reused instance — constructing Intl.DateTimeFormat on every candle inside
// groupHourlyByTradingDay's loop was measurable CPU waste.
const NY_DATE_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
});

// ============================================================
// Yahoo includes the currently-forming candle — copied from ebp-worker.js.
// ============================================================
function getClosedCandles(candles, intervalMs) {
  if (!intervalMs) return candles;
  const now = Date.now();
  return candles.filter(c => {
    const openMs = typeof c.time === 'number' ? c.time : new Date(c.time).getTime();
    return openMs + intervalMs <= now;
  });
}

// ============================================================
// api_call_log cleanup — called_at is unix ms INTEGER, not a SQL datetime
// string; bind a plain ms threshold to avoid type-affinity mismatch that
// would wipe every row unconditionally.
// ============================================================
async function cleanupApiCallLog(db) {
  await db.prepare(
    `DELETE FROM api_call_log WHERE called_at < ?`
  ).bind(Date.now() - 2 * 24 * 60 * 60 * 1000).run();
}

// ============================================================
// Yahoo Finance — primary data source for all breadth pairs.
// Copied verbatim from ebp-worker.js.
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

async function fetchYahooFinance(symbol, tf, outputSize = 50) {
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

// Small yield between symbols so sequential processing doesn't accumulate
// CPU time across a whole per-symbol batch.
async function yieldToRuntime() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ============================================================
// watchdog_log — only failures get logged; successful writes are not
// (too verbose for a per-hour cron × dozens of symbols).
// ============================================================
async function logWatchdog(db, eventType, message) {
  try {
    await db.prepare(
      'INSERT INTO watchdog_log (event_type, message, created_at) VALUES (?, ?, ?)'
    ).bind(eventType, message, new Date().toISOString()).run();
  } catch (e) {
    console.error('[WATCHDOG_LOG] failed to write log:', e.message);
  }

  if (_watchdogAlertEnv) {
    if (eventType === 'error') {
      await sendWatchdogAlert(_watchdogAlertEnv, `🚨 <b>Watchdog Failure</b>\n${message}`);
    } else if (eventType === 'warning') {
      await sendWatchdogAlert(_watchdogAlertEnv, `⚠️ <b>Watchdog Warning</b>\n${message}`);
    }
  }
}

// ============================================================
// D1 write — unified candle_cache (used by writeDXYBlobsToCache)
// ============================================================
async function writeCandleCache(db, symbol, tf, candles) {
  await db.prepare(`
    INSERT OR REPLACE INTO candle_cache (symbol, tf, candles_json, fetched_at)
    VALUES (?, ?, ?, ?)
  `).bind(symbol, tf, JSON.stringify(candles), new Date().toISOString()).run();
}

// ============================================================
// Breadth fetch — Yahoo only, fires in parallel (no per-key credit
// concept to manage). Writes to yahoo_candle_cache — the dedicated
// breadth cache computeSyntheticDXY's constituent reads and
// compute-worker's Market Breadth cron both read from.
// ============================================================
async function fetchBreadthFromYahoo(symbols, env) {
  const results = await Promise.all(
    symbols.map(symbol =>
      fetchYahooFinance(symbol, '1H', 50)
        .then(raw => ({ symbol, raw }))
        .catch(err => ({ symbol, raw: null, error: err }))
    )
  );

  const statements = [];
  let successCount = 0;
  for (const { symbol, raw, error } of results) {
    if (error) {
      await logWatchdog(env.DB, 'error', `Breadth fetch failed for ${symbol}: ${error.message}`);
      continue;
    }
    const closed = getClosedCandles(raw, INTERVAL_MS['1H']);
    if (closed.length >= 20) {
      statements.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO yahoo_candle_cache (symbol, tf, candles_json, fetched_at)
           VALUES (?, ?, ?, ?)`
        ).bind(symbol, '1H', JSON.stringify(closed), new Date().toISOString())
      );
      successCount++;
    } else {
      await logWatchdog(env.DB, 'warning', `${symbol} 1H (breadth): only ${closed.length} closed candles (<20) — skipping D1 write`);
    }
  }
  if (statements.length > 0) await env.DB.batch(statements);
  await logWatchdog(env.DB, 'info', `Breadth fetch complete: ${successCount}/${symbols.length} symbols written`);
}

// ============================================================
// Synthetic DXY — ICE formula computed from the latest closed 1H breadth
// candle of each of 6 constituent pairs. Weights: EUR/USD −0.576,
// USD/JPY +0.136, GBP/USD −0.119, USD/CAD +0.091, USD/SEK +0.042,
// USD/CHF +0.036. Constituents are read from yahoo_candle_cache (written
// by fetchBreadthFromYahoo, which must run first each cycle).
// ============================================================
const DXY_CONSTITUENTS = ['EUR/USD', 'USD/JPY', 'GBP/USD', 'USD/CAD', 'USD/SEK', 'USD/CHF'];
const DXY_WEIGHTS = {
  'EUR/USD': -0.576, 'USD/JPY':  0.136, 'GBP/USD': -0.119,
  'USD/CAD':  0.091, 'USD/SEK':  0.042, 'USD/CHF':  0.036,
};
const DXY_K = 50.14348112;

// Pure ICE-formula computation, shared by computeSyntheticDXY (one
// candle, the latest tick) and seedDXYHistory (one candle per historical
// common timestamp). For high: use low of negatively-weighted pairs
// (they pull DXY down when high) and high of positively-weighted pairs.
// Reverse for low.
function computeDXYCandle(candlesBySymbol, time) {
  const dxy = (getVal) => {
    let v = DXY_K;
    for (const sym of DXY_CONSTITUENTS) v *= Math.pow(getVal(candlesBySymbol[sym], DXY_WEIGHTS[sym]), DXY_WEIGHTS[sym]);
    return parseFloat(v.toFixed(5));
  };
  return {
    time,
    open:  dxy(c => c.open),
    close: dxy(c => c.close),
    high:  dxy((c, w) => w < 0 ? c.low  : c.high),
    low:   dxy((c, w) => w < 0 ? c.high : c.low),
  };
}

async function computeSyntheticDXY(env) {
  const latest = {};
  let alignedTime = null;
  for (const sym of DXY_CONSTITUENTS) {
    // Only the latest closed candle is needed per tick — json_extract
    // pulls it directly rather than parsing the full ~50-candle blob.
    const row = await env.DB.prepare(
      `SELECT json_extract(candles_json, '$[0]') as latest_candle FROM yahoo_candle_cache WHERE symbol = ? AND tf = ?`
    ).bind(sym, '1H').first();
    if (!row || !row.latest_candle) {
      await logWatchdog(env.DB, 'warning', `computeSyntheticDXY: missing latest 1H candle for ${sym} — skipping`);
      return;
    }
    const candle = JSON.parse(row.latest_candle);
    latest[sym] = candle;
    if (alignedTime === null) {
      alignedTime = candle.time;
    } else if (candle.time !== alignedTime) {
      await logWatchdog(env.DB, 'warning', `computeSyntheticDXY: constituent candles not time-aligned (${sym}=${candle.time} vs ${alignedTime}) — skipping`);
      return;
    }
  }

  const candle = computeDXYCandle(latest, alignedTime);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO dxy_candle_cache (tf, candle_time, open, high, low, close, created_at)
    VALUES ('1H', ?, ?, ?, ?, ?, ?)
  `).bind(candle.time, candle.open, candle.high, candle.low, candle.close, new Date().toISOString()).run();
}

// Mirrors the requested dxy_candle_cache timeframes into the shared
// candle_cache (symbol='DXY') as JSON blobs, for any downstream consumer
// that still reads candle_cache rather than dxy_candle_cache directly.
async function writeDXYBlobsToCache(db, tfs, limit = 50) {
  for (const tf of tfs) {
    const { results } = await db.prepare(
      `SELECT candle_time as time, open, high, low, close FROM dxy_candle_cache WHERE tf = ? ORDER BY candle_time DESC LIMIT ?`
    ).bind(tf, limit).all();
    const candles = results ?? [];
    if (!candles.length) continue;
    await writeCandleCache(db, 'DXY', tf, candles);
  }
}

// Runs at every 4H boundary — groups the last 4 x 1H dxy_candle_cache
// rows into one 4H candle.
async function synthesiseDXY4H(db) {
  const { results } = await db.prepare(`
    SELECT candle_time, open, high, low, close
    FROM dxy_candle_cache WHERE tf='1H'
    ORDER BY candle_time DESC LIMIT 4
  `).all();
  if (!results || results.length < 4) return;

  const candles = results; // newest-first
  const candle4H = {
    time:  candles[candles.length - 1].candle_time,
    open:  candles[candles.length - 1].open,
    high:  Math.max(...candles.map(c => c.high)),
    low:   Math.min(...candles.map(c => c.low)),
    close: candles[0].close,
  };

  await db.prepare(`
    INSERT OR IGNORE INTO dxy_candle_cache (tf, candle_time, open, high, low, close, created_at)
    VALUES ('4H', ?, ?, ?, ?, ?, ?)
  `).bind(candle4H.time, candle4H.open, candle4H.high, candle4H.low, candle4H.close, new Date().toISOString()).run();
}

// Runs at 17:00 NY daily close — groups the current trading day's
// 1H dxy_candle_cache rows (17:00 NY → now) into one daily candle.
async function synthesiseDXYDaily(db) {
  const now = Date.now();

  // Only ever called at nyHour===17 (its sole call site's gate), so the
  // trading day that just closed always spans exactly the last 24h.
  const tradingDayOpenMs = now - (24 * 60 * 60 * 1000);

  const { results } = await db.prepare(`
    SELECT candle_time, open, high, low, close
    FROM dxy_candle_cache WHERE tf='1H'
    AND candle_time >= ?
    ORDER BY candle_time ASC
  `).bind(tradingDayOpenMs).all();

  if (!results || results.length < 20) return;

  const candles = results; // oldest-first
  const dailyCandle = {
    time:  candles[0].candle_time,
    open:  candles[0].open,
    high:  Math.max(...candles.map(c => c.high)),
    low:   Math.min(...candles.map(c => c.low)),
    close: candles[candles.length - 1].close,
  };

  await db.prepare(`
    INSERT OR IGNORE INTO dxy_candle_cache (tf, candle_time, open, high, low, close, created_at)
    VALUES ('Daily', ?, ?, ?, ?, ?, ?)
  `).bind(dailyCandle.time, dailyCandle.open, dailyCandle.high, dailyCandle.low, dailyCandle.close, new Date().toISOString()).run();
}

// Runs at Friday 17:00 NY — groups the current week's last 5 Daily
// dxy_candle_cache rows into one weekly candle.
async function synthesiseDXYWeekly(db) {
  const { results } = await db.prepare(`
    SELECT candle_time, open, high, low, close
    FROM dxy_candle_cache WHERE tf='Daily'
    ORDER BY candle_time DESC LIMIT 5
  `).all();
  if (!results || results.length < 5) return;

  const candles = [...results].reverse(); // oldest-first
  const weeklyCandle = {
    time:  candles[0].candle_time,
    open:  candles[0].open,
    high:  Math.max(...candles.map(c => c.high)),
    low:   Math.min(...candles.map(c => c.low)),
    close: candles[candles.length - 1].close,
  };

  await db.prepare(`
    INSERT OR IGNORE INTO dxy_candle_cache (tf, candle_time, open, high, low, close, created_at)
    VALUES ('Weekly', ?, ?, ?, ?, ?, ?)
  `).bind(weeklyCandle.time, weeklyCandle.open, weeklyCandle.high, weeklyCandle.low, weeklyCandle.close, new Date().toISOString()).run();
}

// Cold-start-only backfill — guarded to no-op once dxy_candle_cache has
// any rows at all, so this never re-runs in normal operation.
async function seedDXYHistory(env) {
  const db = env.DB;
  const already = await db.prepare('SELECT COUNT(*) as c FROM dxy_candle_cache').first();
  if ((already?.c ?? 0) > 0) return;

  const allCandles = {};
  for (const sym of DXY_CONSTITUENTS) {
    const row = await db.prepare(
      'SELECT candles_json FROM yahoo_candle_cache WHERE symbol=? AND tf=?'
    ).bind(sym, '1H').first();
    if (!row) {
      await logWatchdog(db, 'warning', `seedDXYHistory: missing yahoo_candle_cache for ${sym} — aborting seed`);
      return;
    }
    allCandles[sym] = JSON.parse(row.candles_json);
  }

  const timeSets = DXY_CONSTITUENTS.map(sym => new Set(allCandles[sym].map(c => c.time)));
  const commonTimes = [...timeSets[0]]
    .filter(t => timeSets.every(s => s.has(t)))
    .sort((a, b) => b - a); // newest-first

  if (commonTimes.length < 10) {
    await logWatchdog(db, 'warning', `seedDXYHistory: only ${commonTimes.length} common timestamps — aborting seed`);
    return;
  }

  const indexMaps = {};
  for (const sym of DXY_CONSTITUENTS) {
    indexMaps[sym] = new Map(allCandles[sym].map(c => [c.time, c]));
  }

  const now = new Date().toISOString();
  const inserts = [];
  for (const t of commonTimes) {
    const latestMap = {};
    for (const sym of DXY_CONSTITUENTS) latestMap[sym] = indexMaps[sym].get(t);
    const dxy = computeDXYCandle(latestMap, t);
    inserts.push(
      db.prepare(`
        INSERT OR IGNORE INTO dxy_candle_cache (tf, candle_time, open, high, low, close, created_at)
        VALUES ('1H', ?, ?, ?, ?, ?, ?)
      `).bind(t, dxy.open, dxy.high, dxy.low, dxy.close, now)
    );
  }

  await db.batch(inserts);
  await logWatchdog(db, 'info', `seedDXYHistory: seeded ${inserts.length} x 1H DXY candles from constituent history`);

  await synthesiseDXY4H(db);
  await synthesiseDXYDaily(db);
  await synthesiseDXYWeekly(db);
  await writeDXYBlobsToCache(db, ['1H', '4H', 'Daily', 'Weekly']);
}

// ============================================================
// Daily synthesis — forex trading day runs 17:00 NY → 16:00 NY the
// next calendar day. A day is complete once its 16:00 NY bar exists.
// ============================================================
function nyDateAndHour(ms) {
  const parts = NY_DATE_HOUR_FMT.formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  return { date: `${map.year}-${map.month}-${map.day}`, hour };
}

// Manual DST calculation for the 4H cron boundary check (getNewYorkHour)
// and the Friday weekly-synthesis gate (getNewYorkDay) — matches the same
// "2nd Sunday of March / 1st Sunday of November" pattern already used in
// worker/src/ebp-worker.js's deriveSession(). The ~6-7 hour transition-day
// edge case is an accepted, pre-existing tradeoff shared with that function.
function getNYOffset(utcMs) {
  const date = new Date(utcMs);
  const year = date.getUTCFullYear();

  // DST start: second Sunday of March
  const marchDate = new Date(Date.UTC(year, 2, 1));
  const marchDay  = marchDate.getUTCDay();
  const dstStart  = new Date(Date.UTC(year, 2, marchDay === 0 ? 8 : 15 - marchDay));

  // DST end: first Sunday of November
  const novDate = new Date(Date.UTC(year, 10, 1));
  const novDay  = novDate.getUTCDay();
  const dstEnd  = new Date(Date.UTC(year, 10, novDay === 0 ? 1 : 8 - novDay));

  const isEDT = date >= dstStart && date < dstEnd;
  return isEDT ? -4 : -5;
}

function getNewYorkHour(utcMs) {
  const nyMs = utcMs + (getNYOffset(utcMs) * 60 * 60 * 1000);
  return new Date(nyMs).getUTCHours();
}

function getNewYorkDay(utcMs) {
  const nyMs = utcMs + (getNYOffset(utcMs) * 60 * 60 * 1000);
  return new Date(nyMs).getUTCDay();
}

// Intl-based NY hour — used only by the daily-digest NY-17:00 gate.
// Distinct from getNewYorkHour() (manual DST rule) — avoids the
// transition-day edge case for a gate that only needs "is it 17:00 NY."
function getNYHour(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(nowMs));
  return parseInt(parts.find(p => p.type === 'hour').value, 10);
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Groups closed 1H candles into forex trading days. Bars from 17:00
// through 23:00 NY belong to the trading day that closes the next
// calendar day (hence the +1), bars from 00:00 through 16:00 NY belong
// to the calendar day they fall on.
function groupHourlyByTradingDay(candles) {
  const groups = new Map();
  for (const c of candles) {
    const { date, hour } = nyDateAndHour(c.time);
    const dateNy = hour >= 17 ? addDaysToDateStr(date, 1) : date;
    if (!groups.has(dateNy)) groups.set(dateNy, []);
    groups.get(dateNy).push({ ...c, nyHour: hour });
  }
  return groups;
}

async function attemptDailySynthesis(symbols, env) {
  for (const symbol of symbols) {
    try {
      const row = await env.DB.prepare(
        'SELECT candles_json FROM candle_cache WHERE symbol = ? AND tf = ? LIMIT 20'
      ).bind(symbol, '1H').first();

      if (row) {
        const hourly = JSON.parse(row.candles_json);
        const groups = groupHourlyByTradingDay(hourly);

        for (const [dateNy, bars] of groups) {
          const dayComplete = bars.some(b => b.nyHour === 16);
          if (!dayComplete) continue;

          const sorted = [...bars].sort((a, b) => a.time - b.time);
          const open  = sorted[0].open;
          const high  = Math.max(...sorted.map(b => b.high));
          const low   = Math.min(...sorted.map(b => b.low));
          const close = sorted[sorted.length - 1].close;

          await env.DB.prepare(`
            INSERT OR IGNORE INTO daily_candle_cache
            (symbol, date_ny, open, high, low, close, synthesised_at)
            VALUES (?,?,?,?,?,?,?)
          `).bind(symbol, dateNy, open, high, low, close, new Date().toISOString()).run();
        }

        await env.DB.prepare(`
          DELETE FROM daily_candle_cache
          WHERE symbol = ? AND date_ny NOT IN (
            SELECT date_ny FROM daily_candle_cache
            WHERE symbol = ? ORDER BY date_ny DESC LIMIT 130
          )
        `).bind(symbol, symbol).run();
      }
    } catch (e) {
      await logWatchdog(env.DB, 'error', `Daily synthesis failed for ${symbol}: ${e.message}`);
    }
    await yieldToRuntime();
  }
}

// ============================================================
// Weekly synthesis — Monday-start ISO week, complete once a Friday
// row exists for that week in daily_candle_cache.
// ============================================================
function getISOWeekMonday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diffToMonday);
  return dt.toISOString().slice(0, 10);
}

async function attemptWeeklySynthesis(symbols, env) {
  for (const symbol of symbols) {
    try {
      const { results } = await env.DB.prepare(
        'SELECT date_ny, open, high, low, close FROM daily_candle_cache WHERE symbol = ? ORDER BY date_ny DESC LIMIT 7'
      ).bind(symbol).all();
      const rows = results ?? [];

      if (rows.length) {
        const groups = new Map();
        for (const r of rows) {
          const monday = getISOWeekMonday(r.date_ny);
          if (!groups.has(monday)) groups.set(monday, []);
          groups.get(monday).push(r);
        }

        for (const [weekStart, bars] of groups) {
          const fridayDate = addDaysToDateStr(weekStart, 4);
          const mondayBar  = bars.find(b => b.date_ny === weekStart);
          const fridayBar  = bars.find(b => b.date_ny === fridayDate);
          if (!mondayBar || !fridayBar) continue; // week incomplete

          const open  = mondayBar.open;
          const high  = Math.max(...bars.map(b => b.high));
          const low   = Math.min(...bars.map(b => b.low));
          const close = fridayBar.close;

          await env.DB.prepare(`
            INSERT OR IGNORE INTO weekly_candle_cache
            (symbol, week_start_ny, week_end_ny, open, high, low, close, synthesised_at)
            VALUES (?,?,?,?,?,?,?,?)
          `).bind(symbol, weekStart, fridayDate, open, high, low, close, new Date().toISOString()).run();
        }

        await env.DB.prepare(`
          DELETE FROM weekly_candle_cache
          WHERE symbol = ? AND week_start_ny NOT IN (
            SELECT week_start_ny FROM weekly_candle_cache
            WHERE symbol = ? ORDER BY week_start_ny DESC LIMIT 26
          )
        `).bind(symbol, symbol).run();
      }
    } catch (e) {
      await logWatchdog(env.DB, 'error', `Weekly synthesis failed for ${symbol}: ${e.message}`);
    }
    await yieldToRuntime();
  }
}

// ============================================================
// EOD operations report — full pipeline snapshot (candle fetch, breadth/
// DXY synthesis, per-symbol signal freshness, daily/weekly synthesis,
// market breadth, NSE, watchdog_log 25h counts). Fires once/day via
// POST /cron/daily-digest (cron-job.org) with a NY-17:00 gate below.
// ============================================================
async function sendWatchdogDailyDigest(env) {
  const db  = env.DB;
  const now = Date.now();

  // NY wall-clock (date+hour+minute) — same Intl shortOffset technique
  // already used in handleWatchdogHealthCheck; getNYHour() alone only
  // returns the hour, not minutes, so this is rebuilt locally rather than
  // widening that helper's contract for one caller.
  const nyParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
    hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(now));
  const nyOffsetHours = parseInt(nyParts.find(p => p.type === 'timeZoneName').value.replace('GMT', ''));
  const nyWallClock    = new Date(now + nyOffsetHours * 3600 * 1000);
  const nyHourNow      = nyWallClock.getUTCHours();
  const nyDayOfWeek    = nyWallClock.getUTCDay(); // 0=Sun..6=Sat

  // IST wall-clock — UTC+5:30, no DST. Same arithmetic as
  // handleWatchdogHealthCheck's NSE session gate.
  const istClock      = new Date(now + 5.5 * 3600 * 1000);
  const istDow         = istClock.getUTCDay();
  const istMinutesNow  = istClock.getUTCHours() * 60 + istClock.getUTCMinutes();
  const nseMarketOpen  = istDow >= 1 && istDow <= 5
    && istMinutesNow >= (9 * 60 + 15) && istMinutesNow < (15 * 60 + 30);

  const isWeekend = isForexClosedWindow(now);

  const hm      = d => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const toMs    = v => (v == null) ? null : new Date(v).getTime();
  const nyTime  = tsMs => tsMs ? `${hm(new Date(tsMs + nyOffsetHours * 3600 * 1000))} NY` : 'never';
  const istTime = tsMs => tsMs ? `${hm(new Date(tsMs + 5.5 * 3600 * 1000))} IST` : 'never';
  const minsAgo = tsMs => tsMs ? Math.round((now - tsMs) / 60000) : Infinity;
  const headerDate = `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][nyDayOfWeek]} ${nyWallClock.getUTCFullYear()}-${String(nyWallClock.getUTCMonth() + 1).padStart(2, '0')}-${String(nyWallClock.getUTCDate()).padStart(2, '0')}`;

  const cutoffIso = new Date(now - 25 * 60 * 60 * 1000).toISOString();

  const [
    activeSymbolsResult,
    configuredTFsResult,
    candleWrites,
    breadthResult,
    dxyResult,
    dailySynthResult,
    weeklySynthResult,
    breadthCacheResult,
    nseResult,
    healthResult,
    lastLogResult,
  ] = await Promise.all([
    // Active signal symbols — same set Watchdog itself fetches.
    db.prepare(`
      SELECT DISTINCT ua.symbol, ua.asset_type
      FROM user_assets ua
      WHERE ua.asset_type IN ('forex','crypto','commodity')
      AND ua.id IN (
        SELECT DISTINCT asset_id FROM user_ebp_configs WHERE enabled=1
        UNION
        SELECT DISTINCT asset_id FROM user_sweep_configs WHERE enabled=1
      )
    `).all(),

    // Which TFs each active symbol actually has an enabled EBP/Sweep config for.
    db.prepare(`
      SELECT ua.symbol, ec.timeframe FROM user_assets ua
      JOIN user_ebp_configs ec ON ec.asset_id = ua.id
      WHERE ec.enabled = 1 AND ua.asset_type IN ('forex','crypto','commodity')
      UNION
      SELECT ua.symbol, sc.timeframe FROM user_assets ua
      JOIN user_sweep_configs sc ON sc.asset_id = ua.id
      WHERE sc.enabled = 1 AND ua.asset_type IN ('forex','crypto','commodity')
    `).all(),

    db.prepare(`
      SELECT symbol, tf, MAX(fetched_at) as last_fetch, COUNT(*) as write_count
      FROM candle_cache
      WHERE fetched_at > ?
      AND symbol IN (SELECT symbol FROM user_assets WHERE asset_type IN ('forex','crypto','commodity'))
      GROUP BY symbol, tf
    `).bind(cutoffIso).all(),

    db.prepare(`
      SELECT COUNT(*) as cnt, MAX(fetched_at) as last_fetch
      FROM yahoo_candle_cache
      WHERE fetched_at > ?
    `).bind(cutoffIso).first(),

    db.prepare(`
      SELECT tf, COUNT(*) as cnt, MAX(created_at) as latest
      FROM dxy_candle_cache
      WHERE created_at > ?
      GROUP BY tf
    `).bind(cutoffIso).all(),

    db.prepare(`SELECT MAX(synthesised_at) as last_synth FROM daily_candle_cache`).first(),

    db.prepare(`SELECT MAX(synthesised_at) as last_synth FROM weekly_candle_cache`).first(),

    db.prepare(`SELECT MAX(computed_at) as last_computed FROM market_breadth_cache WHERE tf='1H'`).first(),

    db.prepare(`SELECT MAX(updated_at) as last_update FROM nse_candle_cache`).first(),

    db.prepare(`
      SELECT event_type, COUNT(*) as cnt
      FROM watchdog_log
      WHERE created_at > ?
      GROUP BY event_type
    `).bind(cutoffIso).all(),

    // Last pipeline activity of any kind — reflects whatever actually ran
    // last (in practice the hourly breadth fetch).
    db.prepare(`
      SELECT message, created_at
      FROM watchdog_log
      ORDER BY created_at DESC
      LIMIT 1
    `).first(),
  ]);

  if (!(healthResult.results?.length)) {
    await sendWatchdogAlert(env,
      '📊 <b>Watchdog EOD Report</b>\n⚠️ No watchdog_log entries in the last 25 hours — Watchdog may not be running.'
    );
    return;
  }

  const activeSymbols = activeSymbolsResult.results ?? [];

  const tfsBySymbol = new Map();
  for (const row of (configuredTFsResult.results ?? [])) {
    if (!tfsBySymbol.has(row.symbol)) tfsBySymbol.set(row.symbol, new Set());
    tfsBySymbol.get(row.symbol).add(row.timeframe);
  }

  const writesBySymbolTf = new Map();
  let candleLastFetchMs = null;
  for (const row of (candleWrites.results ?? [])) {
    writesBySymbolTf.set(`${row.symbol}|${row.tf}`, row);
    const ms = toMs(row.last_fetch);
    if (ms && (!candleLastFetchMs || ms > candleLastFetchMs)) candleLastFetchMs = ms;
  }

  // ── CANDLE FETCH ─────────────────────────────────────────────────────
  // D/W excluded — those TFs are served by daily_candle_cache/
  // weekly_candle_cache, not candle_cache.
  const TF_STALE_MIN = { M15: 30, M30: 35, '1H': 65, '4H': 245 };
  const CANDLE_TFS_EXCLUDED = new Set(['D', '1D', 'W', '1W']);
  let candleChecked = 0;
  let candleFreshCount = 0;
  for (const { symbol, asset_type } of activeSymbols) {
    if (isWeekend && asset_type !== 'crypto') continue;
    const tfs = [...(tfsBySymbol.get(symbol) ?? [])].filter(tf => !CANDLE_TFS_EXCLUDED.has(tf));
    for (const tf of tfs) {
      candleChecked++;
      const ageMs = toMs(writesBySymbolTf.get(`${symbol}|${tf}`)?.last_fetch);
      if (ageMs && minsAgo(ageMs) <= (TF_STALE_MIN[tf] ?? Infinity)) candleFreshCount++;
    }
  }
  const candleFetchSection =
    `<b>CANDLE FETCH</b>\n` +
    `Signal symbols: ${candleFreshCount}/${candleChecked} fresh ${candleFreshCount === candleChecked ? '✅' : '⚠️'}\n` +
    `Last fetch: ${candleLastFetchMs ? nyTime(candleLastFetchMs) : 'no writes in 25h'}`;

  // ── BREADTH FETCH ────────────────────────────────────────────────────
  const breadthFresh  = breadthResult?.cnt ?? 0;
  const breadthLastMs = toMs(breadthResult?.last_fetch);
  const breadthSection =
    `<b>BREADTH FETCH</b>\n` +
    `Expected: hourly (~24 runs/day), ${BREADTH_SYMBOLS.length} symbols per run\n` +
    `Currently fresh: ${breadthFresh}/${BREADTH_SYMBOLS.length} symbols ${breadthFresh >= BREADTH_SYMBOLS.length * 0.95 ? '✅' : '⚠️'}\n` +
    `Last fetch: ${breadthLastMs ? nyTime(breadthLastMs) : 'never'}`;

  // ── DXY SYNTHESIS ────────────────────────────────────────────────────
  const dxyByTf   = new Map((dxyResult.results ?? []).map(r => [r.tf, r]));
  const dxyDailyMs = toMs(dxyByTf.get('Daily')?.latest);
  const dxySection =
    `<b>DXY SYNTHESIS</b>\n` +
    `1H rows (25h): ${dxyByTf.get('1H')?.cnt ?? 0}\n` +
    `4H rows (25h): ${dxyByTf.get('4H')?.cnt ?? 0}\n` +
    `Daily: ${dxyDailyMs && minsAgo(dxyDailyMs) <= 120 ? `✅ ${nyTime(dxyDailyMs)}` : '⚠️ not written'}`;

  // ── SIGNAL CANDLES (per active symbol) ──────────────────────────────
  const signalLines = activeSymbols.map(({ symbol, asset_type }) => {
    if (isWeekend && asset_type !== 'crypto') return `${symbol}: — closed (weekend)`;
    const allTfs = [...(tfsBySymbol.get(symbol) ?? [])];
    const tfs = allTfs.filter(tf => !CANDLE_TFS_EXCLUDED.has(tf));
    if (!allTfs.length) return `${symbol}: no enabled TF config`;
    if (!tfs.length) return `${symbol}: only D/W configured (see DAILY/WEEKLY SYNTHESIS)`;
    const staleTfs = tfs.filter(tf => {
      const ageMs = toMs(writesBySymbolTf.get(`${symbol}|${tf}`)?.last_fetch);
      return !ageMs || minsAgo(ageMs) > (TF_STALE_MIN[tf] ?? Infinity);
    });
    return staleTfs.length ? `${symbol}: ⚠️ stale ${staleTfs.join(',')}` : `${symbol}: ✅ (${tfs.join(',')})`;
  });
  const signalSection = `<b>SIGNAL CANDLES</b>\n${signalLines.join('\n') || 'no active symbols'}`;

  // ── DAILY/WEEKLY SYNTHESIS ───────────────────────────────────────────
  const dailyMs  = toMs(dailySynthResult?.last_synth);
  const weeklyMs = toMs(weeklySynthResult?.last_synth);
  const isFriday17 = nyDayOfWeek === 5 && nyHourNow === 17;
  const dailyWeeklySection =
    `<b>DAILY/WEEKLY SYNTHESIS</b>\n` +
    `Daily: ${dailyMs && minsAgo(dailyMs) <= 120 ? `✅ ${nyTime(dailyMs)}` : '⚠️ not written'}\n` +
    `Weekly: ${isFriday17
      ? (weeklyMs && minsAgo(weeklyMs) <= 120 ? `✅ ${nyTime(weeklyMs)}` : '⚠️ not written')
      : '— not Friday'}`;

  // ── MARKET BREADTH ───────────────────────────────────────────────────
  const breadthCacheMs = toMs(breadthCacheResult?.last_computed);
  const marketBreadthSection =
    `<b>MARKET BREADTH</b>\n` +
    `Last computed: ${breadthCacheMs ? nyTime(breadthCacheMs) : 'never'} ${breadthCacheMs && minsAgo(breadthCacheMs) <= 65 ? '✅' : '⚠️'}`;

  // ── NSE ───────────────────────────────────────────────────────────────
  const nseIsWeekday = istDow >= 1 && istDow <= 5;
  const nseUpdateMs  = toMs(nseResult?.last_update);
  let nseSection;
  if (!nseIsWeekday) {
    nseSection = `<b>NSE</b>\n— Weekend closed`;
  } else if (nseMarketOpen) {
    nseSection = `<b>NSE</b>\nLast update: ${nseUpdateMs ? istTime(nseUpdateMs) : 'never'} ${nseUpdateMs && minsAgo(nseUpdateMs) <= 30 ? '✅' : '⚠️'}`;
  } else if (nseUpdateMs && new Date(nseUpdateMs + 5.5 * 3600 * 1000).getUTCDay() === istDow) {
    nseSection = `<b>NSE</b>\n✅ ${istTime(nseUpdateMs)} (session closed)`;
  } else {
    nseSection = `<b>NSE</b>\n— closed, no data today`;
  }

  // ── HEALTH LOG ───────────────────────────────────────────────────────
  const counts = { info: 0, warning: 0, error: 0 };
  for (const row of (healthResult.results ?? [])) {
    if (row.event_type in counts) counts[row.event_type] = row.cnt;
  }
  const lastLogMs = toMs(lastLogResult?.created_at);
  const healthSection =
    `<b>HEALTH LOG (25h)</b>\n` +
    `✅ Info: ${counts.info} · ⚠️ Warnings: ${counts.warning} · 🚨 Errors: ${counts.error}\n` +
    `Last pipeline log: ${lastLogMs ? nyTime(lastLogMs) : 'never'}`;

  const message =
    `📊 <b>EBP Watchdog — EOD Operations Report</b>\n` +
    `${headerDate} · ${hm(nyWallClock)} NY / ${hm(istClock)} IST\n\n` +
    `${candleFetchSection}\n\n` +
    `${breadthSection}\n\n` +
    `${dxySection}\n\n` +
    `${signalSection}\n\n` +
    `${dailyWeeklySection}\n\n` +
    `${marketBreadthSection}\n\n` +
    `${nseSection}\n\n` +
    `${healthSection}`;

  await sendWatchdogAlert(env, message);
}

// ============================================================
// Forex closed-window gate — used by sendWatchdogDailyDigest to determine
// weekend status for the per-symbol freshness display.
// ============================================================
function isForexClosedWindow(nowMs) {
  const nyStr = new Date(nowMs).toLocaleString('en-US', {
    timeZone: 'America/New_York'
  });
  const ny = new Date(nyStr);
  const day = ny.getDay();    // 0=Sun,1=Mon...5=Fri,6=Sat
  const hour = ny.getHours();
  if (day === 6) return true;               // all Saturday
  if (day === 5 && hour >= 17) return true; // Friday 17:00+ NY
  if (day === 0 && hour < 17) return true;  // Sunday before 17:00 NY
  return false;
}

// ============================================================
// POST /cron/breadth-fetch — breadth/DXY/daily+weekly synthesis ETL.
// Driven by cron-job.org (hourly). No weekend gate — breadth/DXY/
// synthesis run regardless of forex market hours.
// dxy_candle_cache and watchdog_log pruning moved to /cron/prune (Saturday).
// ============================================================
async function handleBreadthFetchCron(env) {
  _watchdogAlertEnv = env;
  try {
    const db  = env.DB;
    const now = Date.now();
    const nyHour = getNewYorkHour(now);
    const nyDay  = getNewYorkDay(now);

    const signalSymbols = await getSignalSymbols(db);

    // Breadth from Yahoo — fetches run in parallel, writing into
    // yahoo_candle_cache. Must run first each cycle so computeSyntheticDXY
    // below has fresh constituent candles.
    await fetchBreadthFromYahoo(BREADTH_SYMBOLS, env);

    // DXY seed (cold-start only, no-ops once dxy_candle_cache has any rows)
    // then per-tick synthetic DXY. Must run after breadth so constituent
    // 1H candles are fresh.
    await seedDXYHistory(env);
    await computeSyntheticDXY(env);

    // 4H/Daily/Weekly DXY synthesis — each gated to its own boundary,
    // then mirrored into candle_cache for consumers reading that table.
    if (NY_4H_BOUNDARIES.includes(nyHour)) {
      await synthesiseDXY4H(db);
      await writeDXYBlobsToCache(db, ['4H']);
    }
    if (nyHour === 17) {
      await synthesiseDXYDaily(db);
      await writeDXYBlobsToCache(db, ['Daily']);
    }
    if (nyHour === 17 && nyDay === 5) {
      await synthesiseDXYWeekly(db);
      await writeDXYBlobsToCache(db, ['Weekly']);
    }
    await writeDXYBlobsToCache(db, ['1H']);

    // Daily/weekly synthesis includes DXY so its candle_cache-sourced
    // daily/weekly candles are built alongside signal-symbol candles.
    if (nyHour === 17) {
      await attemptDailySynthesis([...signalSymbols, 'DXY'], env);
    }

    await cleanupApiCallLog(db);

    if (nyDay === 5 && nyHour === 17) {
      await attemptWeeklySynthesis([...signalSymbols, 'DXY'], env);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('Breadth fetch cron error:', err.message);
    return json({ ok: false, error: err.message }, 500);
  }
}

// ============================================================
// Watchdog health check — external heartbeat, secured by X-Cron-Secret
// (cron-job.org, every 15 min). Moved here from watchdog-worker on
// 2026-08-15 (post-split, ebp-watchdog lost WATCHDOG_BOT_TOKEN/
// WATCHDOG_ADMIN_CHAT_ID so its Telegram alerts were silently no-op'ing;
// market-breath already holds those secrets for the daily digest). Still
// reads the same shared D1 tables (candle_cache, swing_states, etc. —
// written by watchdog/EBP/Sweep Workers) to check on watchdog's own
// activity from outside its process, same rationale as before: a
// CPU-limit kill during watchdog's scheduled() run bypasses every JS
// catch handler there, so this has to be an externally-triggered,
// separate-worker check to catch that blind spot.
// ============================================================
async function handleWatchdogHealthCheck(env) {
  const now = Date.now();
  const nowISO = new Date(now).toISOString();

  // ── DST-aware NY offset — same Intl shortOffset technique used by
  // compute-worker's market-breadth weekend gate. ─────────────────────────
  const nowUtc = new Date(now);
  const nyParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
    hour: 'numeric', minute: 'numeric',
  }).formatToParts(nowUtc);
  const nyOffsetStr   = nyParts.find(p => p.type === 'timeZoneName').value;
  const nyOffsetHours = parseInt(nyOffsetStr.replace('GMT', ''));
  const nyWallClock   = new Date(now + nyOffsetHours * 3600 * 1000);
  const nyHour        = nyWallClock.getUTCHours();
  const nyDayOfWeek   = nyWallClock.getUTCDay(); // 0=Sun, 6=Sat

  // ── NSE market hours: 09:15–15:30 IST (UTC+5:30, no DST) ───────────────
  const istMs      = now + 5.5 * 3600 * 1000;
  const istClock   = new Date(istMs);
  const istHour    = istClock.getUTCHours();
  const istMin     = istClock.getUTCMinutes();
  const istMinutes = istHour * 60 + istMin;
  const nseOpen    = 9 * 60 + 15;   // 09:15
  const nseClose   = 15 * 60 + 30;  // 15:30
  const istDow     = istClock.getUTCDay();
  const nseMarketOpen = istDow >= 1 && istDow <= 5
    && istMinutes >= nseOpen && istMinutes < nseClose;

  // ── Forex market hours — same weekend gate as compute-worker's market breadth ──
  const isForexWeekend =
    (nyDayOfWeek === 5 && nyHour >= 17) ||
    nyDayOfWeek === 6 ||
    (nyDayOfWeek === 0 && nyHour < 17);
  const forexMarketOpen = !isForexWeekend;

  // ── Stale thresholds ─────────────────────────────────────────────────────
  const STALE_20MIN = 20 * 60 * 1000;
  const STALE_30MIN = 30 * 60 * 1000;
  const STALE_35MIN = 35 * 60 * 1000;
  const STALE_65MIN = 65 * 60 * 1000;
  const STALE_2HR   = 2  * 60 * 60 * 1000;

  const failures = [];
  const checks   = {};

  function minsAgo(tsMs) {
    return Math.round((now - tsMs) / 60000);
  }

  // ── Check A: Most recent candle_cache row, any symbol/TF ──────────────────
  if (forexMarketOpen) {
  {
    const row = await env.DB.prepare(
      `SELECT symbol, tf, fetched_at FROM candle_cache ORDER BY fetched_at DESC LIMIT 1`
    ).first();
    if (!row) {
      checks.candle_cache_latest = 'no rows found';
      failures.push('Candle cache: no rows in candle_cache');
    } else {
      const age = now - new Date(row.fetched_at).getTime();
      checks.candle_cache_latest = `${row.symbol} ${row.tf} last fetched ${minsAgo(new Date(row.fetched_at).getTime())} min ago`;
      if (age > STALE_30MIN) {
        failures.push(`Candle cache stale — most recent fetch was ${row.symbol} ${row.tf} at ${row.fetched_at} (${minsAgo(new Date(row.fetched_at).getTime())} min ago, expected ≤30 min)`);
      }
    }
  }

  // ── Check A2: recent Watchdog internal errors/warnings ─────────────────
  // Complements Check A above — that one catches Watchdog going silent
  // entirely; this one catches Watchdog still running but actively logging
  // failures (e.g. a Yahoo/Twelve Data fetch failure) that would otherwise
  // only be visible via a direct D1 query. Ported from the pre-split
  // ebp-worker.js handleWatchdogHealthCheck (added 2026-08-06).
  {
    const thirtyMinsAgo = new Date(now - 30 * 60 * 1000).toISOString();
    const { results: watchdogErrors } = await env.DB.prepare(`
      SELECT event_type, message, created_at
      FROM watchdog_log
      WHERE event_type IN ('error', 'warning')
        AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 5
    `).bind(thirtyMinsAgo).all();

    if (watchdogErrors?.length > 0) {
      checks.watchdog_internal = `${watchdogErrors.length} error/warning(s) in the last 30 min`;
      failures.push(
        `Watchdog internal errors:\n` +
        watchdogErrors.map(r => `  [${r.event_type.toUpperCase()}] ${r.message}`).join('\n')
      );
    } else {
      checks.watchdog_internal = 'no errors/warnings in the last 30 min';
    }
  }

  // ── Check B: Dynamic active symbol+TF probe ────────────────────────────
  // Picks a real currently-configured forex/crypto/commodity symbol+TF
  // (not a hardcoded one that can go stale itself if that config is ever
  // removed) and checks its own candle_cache freshness against a
  // TF-appropriate threshold, rather than only ever checking whatever TF
  // happens to be freshest overall (Check A above).
  {
    const CANDLE_TF_INTERVAL_MS = { M15: 900000, M30: 1800000, '1H': 3600000, '4H': 14400000 };
    const activeConfig = await env.DB.prepare(`
      SELECT ua.symbol, ec.timeframe
      FROM user_assets ua
      JOIN user_ebp_configs ec ON ec.asset_id = ua.id
      WHERE ec.enabled = 1
      AND ua.asset_type != 'nse'
      AND ua.asset_type != 'system'
      ORDER BY ec.timeframe ASC
      LIMIT 1
    `).first();

    if (!activeConfig) {
      checks.candle_cache_active_symbol = 'no active forex/crypto/commodity EBP configs found';
    } else {
      const { symbol, timeframe } = activeConfig;
      const intervalMs = CANDLE_TF_INTERVAL_MS[timeframe];
      const row = await env.DB.prepare(
        `SELECT fetched_at FROM candle_cache WHERE symbol=? AND tf=?`
      ).bind(symbol, timeframe).first();

      if (!row) {
        checks.candle_cache_active_symbol = `no candle_cache row for ${symbol} ${timeframe}`;
        failures.push(`Candle cache missing — active symbol ${symbol} ${timeframe} has no candle_cache row`);
      } else if (intervalMs == null) {
        // Active config's TF isn't one of the intraday TFs this probe
        // covers (e.g. D/W) — report it, but there's no interval to gate on.
        checks.candle_cache_active_symbol = `${symbol} ${timeframe} last fetched ${minsAgo(new Date(row.fetched_at).getTime())} min ago (no threshold for this TF)`;
      } else {
        const age = now - new Date(row.fetched_at).getTime();
        const thresholdMin = Math.round((2 * intervalMs) / 60000);
        checks.candle_cache_active_symbol = `${symbol} ${timeframe} last fetched ${minsAgo(new Date(row.fetched_at).getTime())} min ago`;
        if (age > 2 * intervalMs) {
          failures.push(`Candle cache stale — ${symbol} ${timeframe} last fetched ${minsAgo(new Date(row.fetched_at).getTime())} min ago (expected ≤${thresholdMin} min)`);
        }
      }
    }
  }
  } else {
    checks.candleCache = 'skipped — forex weekend';
  }

  // ── Check: EBP Worker cron activity (swing_states updated) ────────────────
  if (forexMarketOpen) {
    const row = await env.DB.prepare(
      `SELECT symbol, tf, updated_at FROM swing_states
       ORDER BY updated_at DESC LIMIT 1`
    ).first();
    if (!row) {
      checks.ebp_cron = 'no swing_states rows found';
      failures.push('EBP Worker: no swing_states rows — cron may never have fired');
    } else {
      const age = now - new Date(row.updated_at).getTime();
      checks.ebp_cron = `swing_states last updated ${minsAgo(new Date(row.updated_at).getTime())} min ago`;
      if (age > STALE_35MIN) {
        failures.push(`EBP cron stale — swing_states last updated ${minsAgo(new Date(row.updated_at).getTime())} min ago (expected ≤35 min)`);
      }
    }
  } else {
    checks.ebp_cron = 'skipped — forex weekend';
  }

  // ── Check: Sweep Worker cron activity (fvg_zones updated) ──────────────────
  // Event-driven, not every-tick — informational only, never a hard failure.
  if (forexMarketOpen) {
    const row = await env.DB.prepare(
      `SELECT symbol, tf, created_at FROM fvg_zones
       ORDER BY created_at DESC LIMIT 1`
    ).first();
    if (!row) {
      checks.sweep_cron = 'no fvg_zones rows — may be expected if no FVGs detected yet';
    } else {
      checks.sweep_cron = `fvg_zones last entry ${minsAgo(new Date(row.created_at).getTime())} min ago`;
    }
  } else {
    checks.sweep_cron = 'skipped — forex weekend';
  }

  // ── Check C: Market breadth freshness ──────────────────────────────────────
  if (forexMarketOpen) {
    const row = await env.DB.prepare(
      `SELECT snapshot_at FROM market_breadth_intraday
       ORDER BY snapshot_at DESC LIMIT 1`
    ).first();
    if (!row) {
      checks.market_breadth = 'no intraday rows found';
      failures.push('Market breadth: no intraday rows in market_breadth_intraday');
    } else {
      const age = now - row.snapshot_at;
      checks.market_breadth = `last snapshot ${minsAgo(row.snapshot_at)} min ago`;
      if (age > STALE_65MIN) {
        failures.push(`Market breadth stale — last snapshot ${minsAgo(row.snapshot_at)} min ago (expected ≤65 min)`);
      }
    }
  } else {
    checks.market_breadth = 'skipped — forex weekend';
  }

  // ── Check D: Forex SMA Cloud state freshness ────────────────────────────────
  if (forexMarketOpen) {
    const row = await env.DB.prepare(
      `SELECT symbol, timeframe, updated_at FROM forex_sma_state
       ORDER BY updated_at DESC LIMIT 1`
    ).first();
    if (!row) {
      checks.forex_sma = 'no forex_sma_state rows — expected until first SMA config created';
    } else {
      const age = now - new Date(row.updated_at).getTime();
      checks.forex_sma = `${row.symbol} ${row.timeframe} last updated ${minsAgo(new Date(row.updated_at).getTime())} min ago`;
      if (age > STALE_35MIN) {
        failures.push(`Forex SMA state stale — last updated ${minsAgo(new Date(row.updated_at).getTime())} min ago (expected ≤35 min)`);
      }
    }
  } else {
    checks.forex_sma = 'skipped — forex weekend';
  }

  // ── Check: NSE candle cache freshness ───────────────────────────────────────
  // nse_candle_cache.updated_at is an INTEGER ms epoch (confirmed via live
  // PRAGMA table_info) — compare directly, no new Date() wrap needed.
  if (nseMarketOpen) {
    const row = await env.DB.prepare(
      `SELECT symbol, timeframe, updated_at FROM nse_candle_cache
       ORDER BY updated_at DESC LIMIT 1`
    ).first();
    if (!row) {
      checks.nse_candle_cache = 'no rows found';
      failures.push('NSE candle cache: no rows in nse_candle_cache during market hours');
    } else {
      const age = now - row.updated_at;
      checks.nse_candle_cache = `${row.symbol} ${row.timeframe} last updated ${minsAgo(row.updated_at)} min ago`;
      if (age > STALE_20MIN) {
        failures.push(`NSE candle cache stale — ${row.symbol} ${row.timeframe} last updated ${minsAgo(row.updated_at)} min ago (expected ≤20 min)`);
      }
    }
  } else {
    checks.nse_candle_cache = 'skipped — NSE market closed';
  }

  // ── Check: NSE swing state freshness ────────────────────────────────────────
  if (nseMarketOpen) {
    const row = await env.DB.prepare(
      `SELECT symbol, tf, updated_at FROM nse_swing_states
       ORDER BY updated_at DESC LIMIT 1`
    ).first();
    if (!row) {
      checks.nse_swing = 'no rows — expected until first NSE EBP/Sweep config created';
    } else {
      const age = now - new Date(row.updated_at).getTime();
      checks.nse_swing = `${row.symbol} ${row.tf} last updated ${minsAgo(new Date(row.updated_at).getTime())} min ago`;
      if (age > STALE_35MIN) {
        failures.push(`NSE swing state stale — ${row.symbol} ${row.tf} last updated ${minsAgo(new Date(row.updated_at).getTime())} min ago (expected ≤35 min)`);
      }
    }
  } else {
    checks.nse_swing = 'skipped — NSE market closed';
  }

  // ── Check: NSE FVG zone freshness ───────────────────────────────────────────
  // Event-driven, not every-tick, same as forex's fvg_zones check — a row is
  // only written when detectFVG() actually finds a gap (nse-cron.js's
  // processFVGZones), not on every cron tick. Informational only, never a
  // hard failure; a quiet symbol going hours without a fresh FVG is normal.
  if (nseMarketOpen) {
    const row = await env.DB.prepare(
      `SELECT symbol, tf, created_at FROM nse_fvg_zones
       ORDER BY created_at DESC LIMIT 1`
    ).first();
    if (!row) {
      checks.nse_fvg = 'no nse_fvg_zones rows — may be expected if no FVGs detected yet';
    } else {
      checks.nse_fvg = `${row.symbol} ${row.tf} last entry ${minsAgo(new Date(row.created_at).getTime())} min ago`;
    }
  } else {
    checks.nse_fvg = 'skipped — NSE market closed';
  }

  // ── Check: NSE SMA Cloud state freshness ────────────────────────────────────
  // nse_sma_state.updated_at is also INTEGER ms epoch (unlike forex_sma_state's
  // TEXT), but new Date(intMs).getTime() round-trips correctly either way.
  if (nseMarketOpen) {
    const row = await env.DB.prepare(
      `SELECT symbol, timeframe, updated_at FROM nse_sma_state
       ORDER BY updated_at DESC LIMIT 1`
    ).first();
    if (!row) {
      checks.nse_sma = 'no rows — expected until first NSE SMA config created';
    } else {
      const age = now - new Date(row.updated_at).getTime();
      checks.nse_sma = `${row.symbol} ${row.timeframe} last updated ${minsAgo(new Date(row.updated_at).getTime())} min ago`;
      if (age > STALE_2HR) {
        failures.push(`NSE SMA state stale — ${row.symbol} ${row.timeframe} last updated ${minsAgo(new Date(row.updated_at).getTime())} min ago (expected ≤120 min)`);
      }
    }
  } else {
    checks.nse_sma = 'skipped — NSE market closed';
  }

  // ── Determine alert type ──────────────────────────────────────────────────
  const utcHour   = nowUtc.getUTCHours();
  const utcMinute = nowUtc.getUTCMinutes();
  // 2-hourly healthy confirmation: first 15-min tick after every even UTC hour.
  const is2HourlyWindow = utcHour % 2 === 1 && utcMinute < 15;

  // ── Human-readable NY/IST timestamp for Telegram text ───────────────────
  // nyWallClock/istClock are synthetic Date objects whose UTC-getter fields
  // already equal the target timezone's wall-clock fields (same trick used
  // for nyHour/nyMinute/istHour above) — read only via getUTC*, never
  // toLocaleString/timeZone formatting, or it would double-convert.
  function fmtWallClock(d) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const h24  = d.getUTCHours();
    const h12  = h24 % 12 === 0 ? 12 : h24 % 12;
    const ampm = h24 < 12 ? 'AM' : 'PM';
    const mins = String(d.getUTCMinutes()).padStart(2, '0');
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${h12}:${mins} ${ampm}`;
  }
  const tsDisplay = `NY ${fmtWallClock(nyWallClock)} · IST ${fmtWallClock(istClock)}`;

  // ── Send Telegram — reuses this file's own sendWatchdogAlert(), same
  // WATCHDOG_BOT_TOKEN/WATCHDOG_ADMIN_CHAT_ID this worker already sends
  // daily-digest alerts through. ──────────────────────────────────────────
  if (failures.length > 0) {
    const failureLines = failures.map(f => `• ${f}`).join('\n');
    await sendWatchdogAlert(env,
      `🚨 <b>EBP Watchdog — Health Alert</b>\n` +
      `🕐 ${tsDisplay}\n\n` +
      `<b>Failed checks (${failures.length}):</b>\n` +
      `${failureLines}\n\n` +
      `System may be partially or fully offline.`
    );
  } else if (is2HourlyWindow) {
    const marketStatus = forexMarketOpen ? '📈 Forex: open' : '💤 Forex: weekend';
    const nseStatus     = nseMarketOpen ? '📈 NSE: open' : '💤 NSE: closed';
    await sendWatchdogAlert(env,
      `✅ <b>EBP Watchdog — All Systems OK</b>\n` +
      `🕐 ${tsDisplay}\n\n` +
      `${marketStatus} · ${nseStatus}\n` +
      `All ${Object.keys(checks).length} checks passed.`
    );
  }

  return {
    timestamp: nowISO,
    failures: failures.length,
    failureList: failures,
    checks,
    forexMarketOpen,
    nseMarketOpen,
    alertsSent: failures.length > 0 || is2HourlyWindow,
  };
}

// ============================================================
// Export
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, worker: 'market-breath', ts: new Date().toISOString() });
    }

    // External watchdog heartbeat — public route, secured by X-Cron-Secret
    // (cron-job.org, every 15 min). Moved here from ebp-watchdog 2026-08-15
    // — see handleWatchdogHealthCheck's own header comment for why.
    if (url.pathname === '/health/watchdog-check' && request.method === 'POST') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) {
        return json({ error: 'Forbidden' }, 401);
      }
      _watchdogAlertEnv = env;
      try {
        const result = await handleWatchdogHealthCheck(env);
        return json(result, 200);
      } catch (err) {
        console.error('Watchdog health check error:', err.message);
        return json({ error: err.message }, 500);
      }
    }

    // Breadth/DXY/daily+weekly synthesis ETL — hourly via cron-job.org.
    if (url.pathname === '/cron/breadth-fetch' && request.method === 'POST') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) {
        return json({ error: 'Forbidden' }, 401);
      }
      return await handleBreadthFetchCron(env);
    }

    // EOD operations report — driven by cron-job.org (weekdays, 21:05 UTC).
    // NY-17:00 gate and per-instance dedup guard are enforced inside.
    if (url.pathname === '/cron/daily-digest' && request.method === 'POST') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) {
        return json({ error: 'Forbidden' }, 401);
      }

      _watchdogAlertEnv = env;

      const nyHour = getNYHour(Date.now());
      const nyMinute = parseInt(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          minute: 'numeric'
        }).format(new Date())
      );
      const nyDateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York'
      }).format(new Date());

      if (nyHour !== 17 || nyMinute >= 15) {
        return json({ skipped: true, reason: 'outside NY 17:00 window' });
      }
      if (nyDateStr === lastDigestNYDate) {
        return json({ skipped: true, reason: 'already sent today' });
      }
      lastDigestNYDate = nyDateStr;

      try {
        await sendWatchdogDailyDigest(env);
        return json({ ok: true });
      } catch (err) {
        console.error('Daily digest cron error:', err.message);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // Saturday-only weekly DB retention cleanup. dxy_candle_cache is an
    // append-only accumulator (INSERT OR IGNORE) that previously pruned
    // every hour via NOT IN subqueries; this moves that cost to one batch
    // per week using the faster LIMIT 1 OFFSET N pattern (single index
    // seek per table rather than a full NOT IN scan).
    if (url.pathname === '/cron/prune' && request.method === 'POST') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) {
        return json({ error: 'Forbidden' }, 401);
      }

      _watchdogAlertEnv = env;

      const day = new Date().getUTCDay(); // 6 = Saturday UTC
      if (day !== 6) {
        return json({ ok: true, skipped: true, reason: 'not Saturday' });
      }

      try {
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM dxy_candle_cache WHERE tf='1H' AND candle_time < (SELECT candle_time FROM dxy_candle_cache WHERE tf='1H' ORDER BY candle_time DESC LIMIT 1 OFFSET 167)`),
          env.DB.prepare(`DELETE FROM dxy_candle_cache WHERE tf='4H' AND candle_time < (SELECT candle_time FROM dxy_candle_cache WHERE tf='4H' ORDER BY candle_time DESC LIMIT 1 OFFSET 41)`),
          env.DB.prepare(`DELETE FROM dxy_candle_cache WHERE tf='Daily' AND candle_time < (SELECT candle_time FROM dxy_candle_cache WHERE tf='Daily' ORDER BY candle_time DESC LIMIT 1 OFFSET 29)`),
          env.DB.prepare(`DELETE FROM dxy_candle_cache WHERE tf='Weekly' AND candle_time < (SELECT candle_time FROM dxy_candle_cache WHERE tf='Weekly' ORDER BY candle_time DESC LIMIT 1 OFFSET 11)`),
          env.DB.prepare(`DELETE FROM watchdog_log WHERE created_at < datetime('now', '-7 days')`),
        ]);
        await logWatchdog(env.DB, 'info', 'Weekly prune complete (market-breath)');
        return json({ ok: true, pruned: true });
      } catch (err) {
        console.error('Prune cron error:', err.message);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};
