// ============================================================
// EBP Watchdog Worker — Centralised Twelve Data Candle Fetcher
// Zero dependencies — pure Cloudflare Workers runtime only.
//
// Sole Twelve Data caller for all forex/crypto/commodity candle
// data. EBP Worker and Sweep Worker read candle_cache (D1) only.
//
// Single native cron (*/15 * * * *) — all TF fetching is gated
// inside one scheduled() handler; no per-TF cron expressions.
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
// Watchdog Telegram alerts (admin/developer-only — a separate bot
// from the shared user-facing one; see sendWatchdogAlert below)
// ============================================================

// logWatchdog() only ever receives a D1 handle (db), not the full env —
// several of its callers (e.g. getActiveKeys(db)) are themselves only
// passed db, not env, so threading env through every call site would mean
// widening many function signatures. Instead runWatchdog() stashes env
// here at the start of each invocation, and logWatchdog() reads it back —
// scoped to a single scheduled() run, reset every tick before any
// logWatchdog call can fire.
let _watchdogAlertEnv = null;

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
    // swallow — Telegram failure must never crash Watchdog
  }
}

// ============================================================
// Symbol pools
// ============================================================

// Same 28 cross-pairs as MAJOR_PAIRS in worker/src/ebp-worker.js —
// copied verbatim (not imported — this bundle stays dependency-free
// and import-free per architecture rules). Only the pair string is
// needed here; base/quote breakdown is a Market Breadth concern, not
// a fetch/store concern.
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

// Only symbols with at least one enabled EBP or Sweep config — narrower
// than "everything in user_assets," which was spending Twelve Data quota
// on tracked-but-not-actually-alerted-on assets.
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
const TF_TO_INTERVAL = { M15: '15min', M30: '30min', '1H': '1h', '4H': '4h' };

// Forex 4H candles align to the NY trading-day boundary (17:00 NY), not a
// fixed UTC schedule — this set of NY hours maps to a different set of UTC
// hours depending on EDT/EST. Used by handleCandleFetchCron() below.
const NY_4H_BOUNDARIES = [17, 21, 1, 5, 9, 13];

// Copied verbatim from worker/src/ebp-worker.js — used by getClosedCandles.
const INTERVAL_MS = {
  'M5':  5  * 60 * 1000,
  'M15': 15 * 60 * 1000,
  'M30': 30 * 60 * 1000,
  '1H':  60 * 60 * 1000,
  '4H':  4  * 60 * 60 * 1000,
  'D':   24 * 60 * 60 * 1000,
  'W':   7  * 24 * 60 * 60 * 1000,
};

// Shared formatter for nyDateAndHour() — constructing Intl.DateTimeFormat
// is expensive relative to reusing an instance's formatToParts(), and
// nyDateAndHour() is called once per candle inside groupHourlyByTradingDay's
// loop, so a fresh formatter per call was measurable CPU waste.
const NY_DATE_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
});

// ============================================================
// Twelve Data and Yahoo both include the currently-forming candle as
// the most recent element — copied verbatim from ebp-worker.js.
// ============================================================
function getClosedCandles(candles, intervalMs) {
  if (!intervalMs) return candles;
  const now = Date.now();
  return candles.filter(c => {
    const openMs = typeof c.time === 'number' ? c.time : new Date(c.time).getTime();
    return openMs + intervalMs <= now;
  });
}

// Twelve Data's `datetime` field is NY-local wall-clock text — copied
// verbatim from ebp-worker.js.
function nyLocalStringToUTCms(str) {
  const iso     = str.includes(' ') ? str.replace(' ', 'T') : `${str}T00:00:00`;
  const naiveMs = Date.parse(`${iso}Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset'
  }).formatToParts(new Date(naiveMs));
  const offsetStr    = parts.find(p => p.type === 'timeZoneName').value;
  const offsetHours  = parseInt(offsetStr.replace('GMT', ''));
  return naiveMs - offsetHours * 3600 * 1000;
}

// ============================================================
// Twelve Data key rotation — copied verbatim from ebp-worker.js.
// ============================================================
function nextMidnightUTC() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
}

// Resets calls_today (and exhausted state) once per real UTC day for EVERY
// key, not just ones that were marked exhausted — a key that never trips a
// 429 still needs its daily counter cleared, otherwise it accumulates
// forever. Relies on reset_at always holding a real future midnight once a
// key has been through markKeyExhausted at least once; a fresh/never-
// exhausted key sits at reset_at=0 and self-corrects the first time this
// runs post-deploy.
async function resetExhaustedKeys(db) {
  const now = Date.now();
  await db.prepare(
    `UPDATE api_key_state
     SET exhausted=0, calls_today=0, exhausted_at=NULL, reset_at=?
     WHERE reset_at < ?`
  ).bind(nextMidnightUTC(), now).run();
}

// api_call_log cleanup — Sweep Worker no longer owns api_call_log; this is
// its home now.
//
// called_at is stored as Date.now() (unix ms, INTEGER column) — not a SQL
// datetime string. datetime('now','-2 days') returns TEXT, and SQLite's
// type-affinity sort order is NULL < INTEGER/REAL < TEXT, so comparing an
// INTEGER column against that TEXT value would make every row match
// unconditionally (wiping the whole table every run) rather than filtering
// by age. Bind a plain ms threshold instead, same pattern the old Sweep
// Worker cleanup used.
async function cleanupApiCallLog(db) {
  await db.prepare(
    `DELETE FROM api_call_log WHERE called_at < ?`
  ).bind(Date.now() - 2 * 24 * 60 * 60 * 1000).run();
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

// Full list of usable keys for chunk assignment (as opposed to
// getActiveTwelveDataKey, which just answers "is there at least one?").
// key_name is aliased from ak.id, NOT ak.label — api_key_state.key_name is
// always a foreign key to api_keys.id everywhere else in this file; label
// is only the human-readable "Twelve Data Key N" string, kept here
// separately for log messages.
async function getActiveKeys(db) {
  await resetExhaustedKeys(db);

  const { results } = await db.prepare(`
    SELECT ak.id as key_name, ak.label, ak.key_value
    FROM api_keys ak
    LEFT JOIN api_key_state aks ON ak.id = aks.key_name
    WHERE ak.enabled = 1
    AND ak.source = 'twelvedata'
    AND (aks.exhausted IS NULL OR aks.exhausted = 0)
    ORDER BY ak.label ASC
  `).all();

  const keys = results ?? [];
  if (!keys.length) {
    await logWatchdog(db, 'error', 'No active Twelve Data keys available');
  }
  return keys;
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

// Per-minute 429 responses carry code=429 in the JSON body too — that's a
// transient rate limit, not daily credit exhaustion, so it must NOT trip
// this check (only 'run out'/'api credits' messages mean the day's quota
// is actually gone).
function isTwelveDataExhausted(data) {
  if (data?.status === 'error' && data?.message?.toLowerCase().includes('run out')) return true;
  if (data?.status === 'error' && data?.message?.toLowerCase().includes('api credits')) return true;
  return false;
}

async function logApiCall(db, source, symbol, timeframe, success = 1) {
  try {
    await db.prepare(
      'INSERT INTO api_call_log (id, source, symbol, timeframe, called_at, success) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), source, symbol, timeframe, Date.now(), success).run();
  } catch {}
}

// ============================================================
// Yahoo Finance — emergency fallback only, used when every Twelve
// Data key is exhausted. Copied verbatim from ebp-worker.js.
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

// ============================================================
// yieldToRuntime — small yield between symbols so sequential
// processing doesn't accumulate CPU time across the whole batch.
// ============================================================
async function yieldToRuntime() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ============================================================
// watchdog_log — only failures get logged; successful writes
// are not (too verbose for a 15-min cron × dozens of symbols).
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
// Twelve Data signal-symbol fetch — the (small) signal-symbol pool is
// split into chunks of 7, each chunk fired in parallel on its own key
// (breadth no longer goes through Twelve Data at all — see
// fetchBreadthFromYahoo). A 429 here is a per-minute rate limit on that
// specific key, not daily-credit exhaustion, so it's just logged and that
// chunk is skipped this cycle (not marked exhausted — it'll be fine again
// well before the next tick).
// ============================================================
const CHUNK_SIZE = 7;

async function fetchChunkWithKey(chunk, tf, key, env) {
  const resultMap = new Map();
  const interval  = TF_TO_INTERVAL[tf];
  const joined    = chunk.join(',');
  const url       = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(joined)}&interval=${interval}&outputsize=50&timezone=America/New_York&order=DESC&apikey=${key.key_value}`;

  try {
    const res = await fetch(url);

    if (res.status === 429) {
      await logWatchdog(env.DB, 'warning', `TF=${tf} key=${key.key_name} chunk=${chunk.join(',')} got 429 — skipped`);
      return resultMap;
    }
    if (!res.ok) {
      await logWatchdog(env.DB, 'error', `TF=${tf} key=${key.key_name} chunk=${chunk.join(',')} got HTTP ${res.status} — skipped`);
      return resultMap;
    }

    const data = await res.json();
    // Single-symbol chunks come back as a bare {values:[...]} object
    // instead of keyed-by-symbol — normalise so downstream logic is uniform.
    const bySymbol = chunk.length === 1 ? { [chunk[0]]: data } : data;

    const entries = Object.values(bySymbol);
    if (entries.length > 0 && entries.every(v => isTwelveDataExhausted(v))) {
      await markKeyExhausted(env.DB, key.key_name);
      await logWatchdog(env.DB, 'error', `${key.label} exhausted (daily credits) for chunk ${tf}`);
      return resultMap;
    }

    await ensureKeyStateRow(env.DB, key.key_name);
    await incrementKeyCallCount(env.DB, key.key_name);
    await logApiCall(env.DB, key.key_name, `chunk:${chunk.length}`, tf, 1);

    // Proactive exhaustion — Twelve Data reports remaining daily credits in
    // a response header; mark the key exhausted the moment it hits 0
    // instead of waiting for the next call to come back 429.
    const creditsLeft = res.headers.get('api-credits-left');
    if (creditsLeft !== null && parseInt(creditsLeft, 10) === 0) {
      await markKeyExhausted(env.DB, key.key_name);
    }

    for (const symbol of chunk) {
      const entry = bySymbol[symbol];
      if (!entry || entry.status === 'error' || !entry.values) {
        await logWatchdog(env.DB, 'warning', `${symbol} ${tf}: Twelve Data symbol error — ${entry?.message ?? 'no data'}`);
        continue;
      }
      const raw = entry.values.map(v => ({
        open:  parseFloat(v.open),
        high:  parseFloat(v.high),
        low:   parseFloat(v.low),
        close: parseFloat(v.close),
        time:  nyLocalStringToUTCms(v.datetime),
      }));
      resultMap.set(symbol, getClosedCandles(raw, INTERVAL_MS[tf]));
    }

  } catch (e) {
    await logWatchdog(env.DB, 'error', `TF=${tf} key=${key.key_name} chunk fetch error: ${e.message}`);
  }

  return resultMap;
}

// Splits signal symbols into chunks of 7, assigns one key per chunk
// (round-robin — in practice chunks.length never exceeds keys.length once
// the truncation below applies, so this always resolves to chunk i → key
// i), fires them all in parallel, merges the results. Only logs when
// chunks get dropped for lack of keys — per-chunk assignment on the
// success path is deliberately not logged, matching this file's existing
// "only failures get logged" convention for watchdog_log.
async function fetchSignalTF(symbols, tf, keys, env) {
  const resultMap = new Map();
  if (!symbols.length || !keys.length) return resultMap;

  const chunks = [];
  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    chunks.push(symbols.slice(i, i + CHUNK_SIZE));
  }

  let assignedChunks = chunks;
  if (chunks.length > keys.length) {
    const skipped        = chunks.slice(keys.length);
    const skippedSymbols = skipped.flat();
    await logWatchdog(env.DB, 'warning',
      `TF=${tf} has ${chunks.length} chunks but only ${keys.length} keys — ${skipped.length} chunks skipped. Skipped symbols: ${skippedSymbols.join(',')}`);
    assignedChunks = chunks.slice(0, keys.length);
  }

  const chunkResults = await Promise.all(
    assignedChunks.map((chunk, i) => fetchChunkWithKey(chunk, tf, keys[i % keys.length], env))
  );

  for (const chunkMap of chunkResults) {
    for (const [symbol, candles] of chunkMap) {
      resultMap.set(symbol, candles);
    }
  }

  return resultMap;
}

// ============================================================
// D1 write — unified candle_cache
// ============================================================
async function writeCandleCache(db, symbol, tf, candles) {
  await db.prepare(`
    INSERT OR REPLACE INTO candle_cache (symbol, tf, candles_json, fetched_at)
    VALUES (?, ?, ?, ?)
  `).bind(symbol, tf, JSON.stringify(candles), new Date().toISOString()).run();
}

// Dedicated Yahoo-sourced breadth cache — same shape/pattern as
// writeCandleCache, separate table so breadth-pair blobs never collide
// with signal-symbol candle_cache rows. Read by computeSyntheticDXY's
// constituent lookups and by compute-worker's Market Breadth cron.
async function writeYahooCandleCache(db, symbol, tf, candles) {
  await db.prepare(`
    INSERT OR REPLACE INTO yahoo_candle_cache (symbol, tf, candles_json, fetched_at)
    VALUES (?, ?, ?, ?)
  `).bind(symbol, tf, JSON.stringify(candles), new Date().toISOString()).run();
}

// Fetches one TF for the signal-symbol pool via the parallel chunk
// architecture, falling back to Yahoo per-symbol if every Twelve Data key
// is exhausted (checked fresh via getActiveTwelveDataKey, not the possibly
// stale `keys` list loaded once at the top of runWatchdog — a key can
// become exhausted mid-tick between TFs in the stagger sequence). Signal
// symbols always get real candle data one way or another; only the
// source varies. Writes each valid result to D1.
async function fetchSignalAndStore(symbols, tf, keys, env) {
  if (!symbols.length) return;

  let resultMap;
  const active = await getActiveTwelveDataKey(env.DB);
  if (!active) {
    resultMap = new Map();
    await logWatchdog(env.DB, 'error', `All Twelve Data keys exhausted — falling back to Yahoo for ${tf} (${symbols.length} signal symbols)`);
    for (const symbol of symbols) {
      try {
        const raw    = await fetchYahooFinance(symbol, tf, 50);
        const closed = getClosedCandles(raw, INTERVAL_MS[tf]);
        resultMap.set(symbol, closed);
        await logApiCall(env.DB, 'yahoo', symbol, tf, 1);
      } catch (e) {
        await logWatchdog(env.DB, 'error', `Symbol fetch failure ${symbol} ${tf}: Yahoo fallback also failed — ${e.message}`);
      }
      await yieldToRuntime();
    }
  } else {
    resultMap = await fetchSignalTF(symbols, tf, keys, env);
  }

  const statements = [];
  for (const symbol of symbols) {
    const candles = resultMap.get(symbol);
    if (candles && candles.length >= 20) {
      statements.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO candle_cache (symbol, tf, candles_json, fetched_at)
           VALUES (?, ?, ?, ?)`
        ).bind(symbol, tf, JSON.stringify(candles), new Date().toISOString())
      );
    } else if (candles) {
      await logWatchdog(env.DB, 'warning', `${symbol} ${tf}: only ${candles.length} closed candles (<20) — skipping D1 write`);
    }
  }
  if (statements.length > 0) await env.DB.batch(statements);
}

// Breadth is Yahoo-only — fetches fire in parallel (no per-key credit
// concept to manage, unlike Twelve Data), each isolated by its own
// .catch so one symbol failing doesn't abort the batch. Reuses
// fetchYahooFinance (symbol translation, interval/range mapping,
// unix-seconds→ms, forming-candle exclusion) rather than re-implementing
// the same parsing a second time. Writes to yahoo_candle_cache — the
// dedicated breadth cache computeSyntheticDXY's constituent reads and
// compute-worker's Market Breadth cron both read from; breadth pairs no
// longer also get written into the shared candle_cache (nothing reads
// them there once DXY/breadth moved onto yahoo_candle_cache).
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
// by fetchBreadthFromYahoo, which must run first each cycle) — not the
// shared candle_cache, which nothing downstream reads breadth pairs from
// anymore.
// ============================================================
const DXY_CONSTITUENTS = ['EUR/USD', 'USD/JPY', 'GBP/USD', 'USD/CAD', 'USD/SEK', 'USD/CHF'];
const DXY_WEIGHTS = {
  'EUR/USD': -0.576, 'USD/JPY':  0.136, 'GBP/USD': -0.119,
  'USD/CAD':  0.091, 'USD/SEK':  0.042, 'USD/CHF':  0.036,
};
const DXY_K = 50.14348112;

// Pure ICE-formula computation, shared by computeSyntheticDXY (one
// candle, the latest tick) and seedDXYHistory (one candle per historical
// common timestamp) — candlesBySymbol maps each DXY_CONSTITUENTS entry to
// a single {open,high,low,close} candle at the given time. For high: use
// low of negatively-weighted pairs (they pull DXY down when high) and
// high of positively-weighted pairs. Reverse for low.
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
// Reuses getNewYorkHour() (defined below) — same manual-DST helper the
// rest of this file's cron gating already uses.
async function synthesiseDXYDaily(db) {
  const now = Date.now();

  // Only ever called at nyHour===17 (its sole call site's gate), so the
  // trading day that just closed always spans exactly the last 24h —
  // no need to derive an open time relative to the current NY hour.
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
// any rows at all, so this never re-runs in normal operation. Bulk-reads
// full yahoo_candle_cache history for all 6 constituents (unlike the
// per-tick computeSyntheticDXY, a one-time backfill genuinely needs the
// full common history, not just the latest candle), computes one DXY
// candle per common timestamp, then derives 4H/Daily/Weekly and mirrors
// all four into candle_cache the same way a normal cycle would.
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
// worker/src/ebp-worker.js's deriveSession(), kept consistent rather than
// substituted for the more precise Intl-based nyDateAndHour above. Note:
// comparing against midnight UTC of the transition date (rather than the
// actual 2am-local transition instant) means there's a ~6-7 hour window on
// the two transition days each year where this is off by one hour — an
// accepted, pre-existing tradeoff shared with deriveSession(), not new
// here.
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

// Intl-based NY hour — used only by the daily-digest EOD gate in
// runWatchdog(). Distinct from getNewYorkHour() above (which uses the
// manual 2nd-Sunday-March/1st-Sunday-November DST rule, with its
// documented ~6-7hr transition-day edge case); this one avoids that
// tradeoff for a gate that only needs to check "is it currently 17:00 NY."
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
// market breadth, NSE, watchdog_log 25h counts). Replaces the old
// watchdog_log-only digest. Fires once/day via the same NY-17:00 gate in
// runWatchdog() — 11 parallel D1 reads at that cadence is cheap.
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
    // Active signal symbols — same set Watchdog itself fetches (mirrors
    // getSignalSymbols' EXISTS logic via IN/UNION per the audited spec),
    // widened to also return asset_type for weekend forex/crypto branching.
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

    // Which TFs each active symbol actually has an enabled EBP/Sweep
    // config for — drives the per-symbol freshness check below so a
    // symbol only configured for M15 isn't flagged stale for 4H.
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

    // Last pipeline activity of any kind — replaces an earlier version of
    // this query that looked for the native scheduled() heartbeat message
    // specifically. That cron is dormant (no [triggers] entry), so it
    // always showed a stale multi-hour-old timestamp even when the real
    // ETL (cron-job.org-driven) was running fine. This reflects whatever
    // actually ran last, which in practice is the hourly breadth fetch.
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
  // Freshness check, not a write-count — candle_cache is INSERT OR REPLACE
  // (one row per symbol+tf), so a 24h write-count can never exceed 1 per
  // pair and was structurally incapable of matching an "expected ~576"
  // target. D/W excluded — those TFs are served by daily_candle_cache/
  // weekly_candle_cache, not candle_cache (see SIGNAL CANDLES below and
  // DAILY/WEEKLY SYNTHESIS), so candle_cache never has rows for them by
  // design, not by failure.
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
  // yahoo_candle_cache is INSERT OR REPLACE (one row per symbol+tf), so
  // this can only ever report "how many of the N symbols currently have a
  // fresh row," never a cumulative writes-across-24-runs count — no write
  // history is retained to count.
  const breadthFresh  = breadthResult?.cnt ?? 0;
  const breadthLastMs = toMs(breadthResult?.last_fetch);
  const breadthSection =
    `<b>BREADTH FETCH</b>\n` +
    `Expected: hourly (~24 runs/day), ${BREADTH_SYMBOLS.length} symbols per run\n` +
    `Currently fresh: ${breadthFresh}/${BREADTH_SYMBOLS.length} symbols ${breadthFresh >= BREADTH_SYMBOLS.length * 0.95 ? '✅' : '⚠️'}\n` +
    `Last fetch: ${breadthLastMs ? nyTime(breadthLastMs) : 'never'}`;

  // ── DXY SYNTHESIS ────────────────────────────────────────────────────
  // Uses dxy_candle_cache (dxyResult) throughout, including for the Daily
  // row — not the generic daily_candle_cache MAX (that's a different
  // table, reserved for the DAILY/WEEKLY SYNTHESIS section below, which
  // covers the signal-symbol+DXY combined attemptDailySynthesis batch).
  const dxyByTf   = new Map((dxyResult.results ?? []).map(r => [r.tf, r]));
  const dxyDailyMs = toMs(dxyByTf.get('Daily')?.latest);
  const dxySection =
    `<b>DXY SYNTHESIS</b>\n` +
    `1H rows (25h): ${dxyByTf.get('1H')?.cnt ?? 0}\n` +
    `4H rows (25h): ${dxyByTf.get('4H')?.cnt ?? 0}\n` +
    `Daily: ${dxyDailyMs && minsAgo(dxyDailyMs) <= 120 ? `✅ ${nyTime(dxyDailyMs)}` : '⚠️ not written'}`;

  // ── SIGNAL CANDLES (per active symbol) ──────────────────────────────
  // D/W excluded from the candle_cache freshness check — see
  // CANDLE_TFS_EXCLUDED above. Those TFs are correctly reported in
  // DAILY/WEEKLY SYNTHESIS instead.
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
// Forex closed-window gate — used by handleCandleFetchCron() below to
// skip forex/commodity fetches while the forex market is shut (crypto
// still trades 24/7, so it's fetched regardless).
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
// Cron-gated orchestration
// ============================================================
async function runWatchdog(event, env) {
  _watchdogAlertEnv = env;

  const db     = env.DB;
  const minute = new Date(event.scheduledTime).getUTCMinutes();

  // Daily summary digest — first tick after NY 17:00 (DST-aware via
  // getNYHour), matching the EOD gate handleWatchdogHealthCheck() already
  // uses. Was hardcoded to plain UTC hour 8 — which is IST ~13:30
  // (afternoon), unrelated to NY close and the source of a "fires at the
  // wrong time" bug report.
  if (minute < 15 && getNYHour(event.scheduledTime) === 17) {
    await sendWatchdogDailyDigest(env);
  }

  // ETL (signal-symbol fetch + breadth/DXY/synthesis) moved to
  // POST /cron/candle-fetch and POST /cron/breadth-fetch — this native CF
  // cron tick is now a near-zero-CPU heartbeat only.
  await logWatchdog(db, 'info', 'Watchdog scheduled tick — heartbeat');
}

// ============================================================
// POST /cron/candle-fetch — signal-symbol Twelve Data/Yahoo ETL, extracted
// verbatim from the old runWatchdog() signal-fetch block. Driven by
// cron-job.org (every 15 min) instead of the native CF scheduled() cron.
// ============================================================
async function handleCandleFetchCron(env) {
  try {
    const db     = env.DB;
    const now    = Date.now();
    const minute = new Date(now).getUTCMinutes();
    const nyHour = getNewYorkHour(now);

    const signalSymbols = await getSignalSymbols(db);
    const keys = await getActiveKeys(db); // also logs if empty

    // Assign dedicated key per TF by label — stable against exhaustion-driven
    // index shifts (exhausted keys drop from the array, shifting [0],[1]…).
    const keyM15 = keys.find(k => k.label === 'Twelve Data Key 1');
    const keyM30 = keys.find(k => k.label === 'Twelve Data Key 2');
    const key1H  = keys.find(k => k.label === 'Twelve Data Key 3');
    const key4H  = keys.find(k => k.label === 'Twelve Data Key 4');

    // Forex closed-window gate — crypto trades 24/7 so it's unaffected;
    // forex/commodity symbols are skipped while the forex market is shut.
    let symbolsForFetch = signalSymbols;

    if (isForexClosedWindow(now)) {
      let forexSymbols    = signalSymbols;
      let nonForexSymbols = [];

      if (signalSymbols.length > 0) {
        const placeholders = signalSymbols.map(() => '?').join(',');
        const { results: cryptoRows } = await db.prepare(
          `SELECT symbol FROM user_assets WHERE symbol IN (${placeholders}) AND asset_type = 'crypto'`
        ).bind(...signalSymbols).all();
        const cryptoSet = new Set((cryptoRows ?? []).map(r => r.symbol));
        nonForexSymbols = signalSymbols.filter(s => cryptoSet.has(s));
        forexSymbols    = signalSymbols.filter(s => !cryptoSet.has(s));
      }

      if (nonForexSymbols.length === 0) {
        await logWatchdog(db, 'info', 'Forex closed + no crypto symbols — nothing to fetch');
        return json({ ok: true, symbols: 0, tfs: [] });
      }

      await logWatchdog(db, 'info',
        `Forex closed window — skipping ${forexSymbols.length} forex symbols, fetching ${nonForexSymbols.length} crypto symbols only`);
      symbolsForFetch = nonForexSymbols;
    }

    if (symbolsForFetch.length === 0) {
      await logWatchdog(db, 'warning', 'No active signal symbols — skipping');
      return json({ ok: true, symbols: 0, tfs: [] });
    }

    // Build parallel fetch array — only push TFs that are due this tick.
    const fetches = [];
    const tfs     = [];

    fetches.push(fetchSignalAndStore(symbolsForFetch, 'M15', keyM15 ? [keyM15] : [], env));
    tfs.push('M15');

    if (minute % 30 === 0) {
      fetches.push(fetchSignalAndStore(symbolsForFetch, 'M30', keyM30 ? [keyM30] : [], env));
      tfs.push('M30');
    }

    if (minute === 0) {
      fetches.push(fetchSignalAndStore(symbolsForFetch, '1H', key1H ? [key1H] : [], env));
      tfs.push('1H');
    }

    if (minute === 0 && NY_4H_BOUNDARIES.includes(nyHour)) {
      fetches.push(fetchSignalAndStore(symbolsForFetch, '4H', key4H ? [key4H] : [], env));
      tfs.push('4H');
    }

    await Promise.all(fetches);

    return json({ ok: true, symbols: symbolsForFetch.length, tfs });
  } catch (err) {
    console.error('Candle fetch cron error:', err.message);
    return json({ ok: false, error: err.message }, 500);
  }
}

// ============================================================
// POST /cron/breadth-fetch — breadth/DXY/daily+weekly synthesis ETL,
// extracted verbatim from the old runWatchdog() minute===0 block. Driven by
// cron-job.org (hourly) instead of the native CF scheduled() cron. No
// weekend gate — breadth/DXY/synthesis run regardless of forex market
// hours, matching prior behaviour.
// ============================================================
async function handleBreadthFetchCron(env) {
  try {
    const db  = env.DB;
    const now = Date.now();
    const nyHour = getNewYorkHour(now);
    const nyDay  = getNewYorkDay(now);

    const signalSymbols = await getSignalSymbols(db);

    // Breadth from Yahoo — fetches run in parallel now (see
    // fetchBreadthFromYahoo), writing into yahoo_candle_cache. This is
    // now compute-worker's Market Breadth cron's sole data source for
    // breadth pairs, and computeSyntheticDXY's constituent source below —
    // must run first each cycle so both have fresh data.
    await fetchBreadthFromYahoo(BREADTH_SYMBOLS, env);

    // DXY seed (cold-start only, no-ops once dxy_candle_cache has any
    // rows) then per-tick synthetic DXY — must run after breadth so
    // constituent 1H candles are fresh (EUR/USD, USD/JPY, GBP/USD,
    // USD/CAD, USD/SEK, USD/CHF all live in BREADTH_SYMBOLS and are
    // written by fetchBreadthFromYahoo above).
    await seedDXYHistory(env);
    await computeSyntheticDXY(env);

    // 4H/Daily/Weekly DXY synthesis — each gated to its own boundary,
    // sourced from dxy_candle_cache's own 1H/Daily rows (not candle_cache
    // or daily_candle_cache), then mirrored into candle_cache for any
    // consumer still reading candle_cache directly.
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
    // daily/weekly candles are built alongside signal-symbol candles too
    // — this runs in addition to (not instead of) dxy_candle_cache's own
    // dedicated Daily/Weekly rows above; both are real, intentionally
    // parallel outputs. Market Breadth itself reads yahoo_candle_cache
    // directly (compute-worker), not candle_cache.
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
// (cron-job.org, every 15 min). Runs as its own fetch() invocation,
// completely independent of this worker's own scheduled() cron — a
// CPU-limit kill during a scheduled() run bypasses every JS catch handler
// (including runWatchdog()'s own outer .catch() in the export below), so
// Watchdog can never alert on its own termination from inside scheduled()
// itself. This route is the external, separately-triggered check that
// catches that blind spot by reading the freshness of what Watchdog's
// cron is supposed to be writing.
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
  const nyMinute      = nyWallClock.getUTCMinutes();
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
  // Not market-hours gated — Watchdog's own M15 fetch tick runs on a fixed
  // */15 schedule year-round for the whole signal-symbol pool (forex,
  // crypto, commodity alike), and writeCandleCache() stamps fetched_at to
  // "now" on every successful write regardless of whether the underlying
  // candle itself is a stale weekend bar. So fetched_at tracks "is
  // Watchdog's cron alive and writing," not "is the market open" — gating
  // this on forex hours would just blind the check during every weekend.
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
  const is2HourlyWindow = utcHour % 2 === 0 && utcMinute < 15;
  // EOD report: first 15-min tick after NY 5PM (DST-safe via nyHour above).
  const isEodWindow = nyHour === 17 && nyMinute < 15;

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
  // watchdog_log alerts through. ──────────────────────────────────────────
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
  if (isEodWindow) {
    const checksText = Object.entries(checks).map(([k, v]) => `• ${k}: ${v}`).join('\n');
    const status = failures.length === 0 ? '✅ All clear' : `⚠️ ${failures.length} issue(s) detected`;
    await sendWatchdogAlert(env,
      `📊 <b>EBP Watchdog — EOD Report (NY 5PM)</b>\n` +
      `🕐 ${tsDisplay}\n\n` +
      `Status: ${status}\n\n` +
      `<b>System checks:</b>\n` +
      `${checksText}`
    );
  }

  return {
    timestamp: nowISO,
    failures: failures.length,
    failureList: failures,
    checks,
    forexMarketOpen,
    nseMarketOpen,
    alertsSent: failures.length > 0 || is2HourlyWindow || isEodWindow,
  };
}

// ============================================================
// Export
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, worker: 'ebp-watchdog', ts: new Date().toISOString() });
    }

    // External heartbeat — public route, secured by X-Cron-Secret
    // (cron-job.org, every 15 min), same auth pattern as /cron/ebp.
    if (url.pathname === '/health/watchdog-check' && request.method === 'POST') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) {
        return json({ error: 'Forbidden' }, 401);
      }
      try {
        const result = await handleWatchdogHealthCheck(env);
        return json(result, 200);
      } catch (err) {
        console.error('Watchdog health check error:', err.message);
        return json({ error: err.message }, 500);
      }
    }

    // Signal-symbol candle ETL — extracted from the native scheduled() cron
    // to keep that handler's CPU time near-zero. cron-job.org, every 15 min.
    if (url.pathname === '/cron/candle-fetch' && request.method === 'POST') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) {
        return json({ error: 'Forbidden' }, 401);
      }
      return await handleCandleFetchCron(env);
    }

    // Breadth/DXY/daily+weekly synthesis ETL — same extraction, hourly.
    if (url.pathname === '/cron/breadth-fetch' && request.method === 'POST') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) {
        return json({ error: 'Forbidden' }, 401);
      }
      return await handleBreadthFetchCron(env);
    }

    // EOD operations report — driven by cron-job.org (weekdays, 21:05 UTC).
    // sendWatchdogDailyDigest() itself is unchanged; this route is now the
    // only way it's invoked, since the native scheduled() cron's own
    // NY-17:00 gate in runWatchdog() is dormant with no [triggers] entry.
    if (url.pathname === '/cron/daily-digest' && request.method === 'POST') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) {
        return json({ error: 'Forbidden' }, 401);
      }
      try {
        await sendWatchdogDailyDigest(env);
        return json({ ok: true });
      } catch (err) {
        console.error('Daily digest cron error:', err.message);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runWatchdog(event, env).catch(async (e) => {
        console.error('[WATCHDOG] Unhandled error:', e.message);
        _watchdogAlertEnv = env; // defensive — runWatchdog() sets this as its first line, but re-set here in case it threw before reaching it
        await logWatchdog(env.DB, 'error', `Unhandled scheduled() error: ${e.message}`);
      })
    );
  },
};
