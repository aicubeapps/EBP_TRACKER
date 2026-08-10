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

// api_call_log cleanup — used to run on Sweep Worker's M5 tick; that tick
// (and Sweep Worker's ownership of api_call_log entirely) is gone as of the
// Watchdog migration, so this is its new home.
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
    '1H': '21d', '4H': '60d', 'D': '1mo', 'W': '3mo',
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

  for (const symbol of symbols) {
    const candles = resultMap.get(symbol);
    if (candles && candles.length >= 20) {
      await writeCandleCache(env.DB, symbol, tf, candles);
    } else if (candles) {
      await logWatchdog(env.DB, 'warning', `${symbol} ${tf}: only ${candles.length} closed candles (<20) — skipping D1 write`);
    }
    await yieldToRuntime();
  }
}

// Breadth is Yahoo-only now — sequential per-symbol, no per-key credit
// concept to manage. Reuses fetchYahooFinance (symbol translation,
// interval/range mapping, unix-seconds→ms, forming-candle exclusion)
// rather than re-implementing the same parsing a second time.
async function fetchBreadthFromYahoo(symbols, env) {
  let successCount = 0;
  for (const symbol of symbols) {
    try {
      const raw    = await fetchYahooFinance(symbol, '1H', 510);
      const closed = getClosedCandles(raw, INTERVAL_MS['1H']);
      if (closed.length >= 20) {
        await writeYahooCandleCache(env.DB, symbol, '1H', closed);
        successCount++;
      } else {
        await logWatchdog(env.DB, 'warning', `${symbol} 1H (breadth): only ${closed.length} closed candles (<20) — skipping D1 write`);
      }
    } catch (e) {
      await logWatchdog(env.DB, 'error', `Breadth fetch failed for ${symbol}: ${e.message}`);
    }
    await yieldToRuntime();
  }
  await logWatchdog(env.DB, 'info', `Breadth fetch complete: ${successCount}/${symbols.length} symbols written`);
}

// ============================================================
// Synthetic DXY — ICE formula, row-per-candle accumulator design.
// On cold start: seeds dxy_candle_cache from 21d of yahoo_candle_cache.
// On normal run: appends one 1H row from the latest closed bar.
// Signal workers read candle_cache blobs written by writeDXYBlobsToCache.
// ============================================================
async function computeSyntheticDXY(db, nowMs) {
  const CONSTITUENTS = [
    { symbol: 'EUR/USD', exponent: -0.576 },
    { symbol: 'USD/JPY', exponent:  0.136 },
    { symbol: 'GBP/USD', exponent: -0.119 },
    { symbol: 'USD/CAD', exponent:  0.091 },
    { symbol: 'USD/SEK', exponent:  0.042 },
    { symbol: 'USD/CHF', exponent:  0.036 },
  ];
  const ICE_FACTOR = 50.14348112;

  // --- Step 1: detect cold start ---
  const countRow = await db.prepare(
    'SELECT COUNT(*) as cnt FROM dxy_candle_cache WHERE tf=?'
  ).bind('1H').first();
  const isColdStart = !countRow || countRow.cnt === 0;

  if (isColdStart) {
    return await seedDXYHistory(db, CONSTITUENTS, ICE_FACTOR);
  }

  // --- Step 2: normal run — compute single latest closed 1H candle ---
  const latest = {};
  for (const { symbol } of CONSTITUENTS) {
    const row = await db.prepare(
      'SELECT candles_json FROM yahoo_candle_cache WHERE symbol=? AND tf=?'
    ).bind(symbol, '1H').first();
    if (!row) {
      await logWatchdog(db, 'warning',
        `computeSyntheticDXY: missing yahoo_candle_cache for ${symbol}`);
      return;
    }
    const candles = JSON.parse(row.candles_json);
    if (!candles || candles.length === 0) {
      await logWatchdog(db, 'warning',
        `computeSyntheticDXY: empty candles for ${symbol}`);
      return;
    }
    latest[symbol] = candles[0]; // newest closed candle
  }

  // Verify all constituents share the same latest timestamp
  const times = CONSTITUENTS.map(c => latest[c.symbol].time);
  const allSameTime = times.every(t => t === times[0]);
  if (!allSameTime) {
    await logWatchdog(db, 'warning',
      `computeSyntheticDXY: constituent timestamp mismatch — ${JSON.stringify(times)}`);
    // Still proceed with the most recent common timestamp
  }

  // Compute DXY OHLC for this single candle using ICE formula
  const dxyCandle = computeDXYCandle(
    CONSTITUENTS, latest, ICE_FACTOR,
    times[0] // use first constituent's time as candle_time
  );

  // --- Step 3: append to dxy_candle_cache ---
  await db.prepare(`
    INSERT OR IGNORE INTO dxy_candle_cache (tf, candle_time, open, high, low, close, created_at)
    VALUES ('1H', ?, ?, ?, ?, ?, ?)
  `).bind(
    dxyCandle.time,
    dxyCandle.open, dxyCandle.high, dxyCandle.low, dxyCandle.close,
    new Date(nowMs).toISOString()
  ).run();

  // --- Step 4: write blobs to candle_cache for signal workers ---
  await writeDXYBlobsToCache(db, ['1H']);
}

// Computes a single DXY OHLC candle from per-constituent latest bars
function computeDXYCandle(constituents, latestMap, iceFactor, candleTime) {
  let open = iceFactor, high = iceFactor, low = iceFactor, close = iceFactor;
  for (const { symbol, exponent } of constituents) {
    const c = latestMap[symbol];
    if (exponent < 0) {
      open  *= Math.pow(c.open,  exponent);
      high  *= Math.pow(c.low,   exponent); // inverted for negative exponent
      low   *= Math.pow(c.high,  exponent); // inverted for negative exponent
      close *= Math.pow(c.close, exponent);
    } else {
      open  *= Math.pow(c.open,  exponent);
      high  *= Math.pow(c.high,  exponent);
      low   *= Math.pow(c.low,   exponent);
      close *= Math.pow(c.close, exponent);
    }
  }
  return { time: candleTime, open, high, low, close };
}

// Reads latest 50 rows from dxy_candle_cache for each TF,
// serialises as blob, writes to candle_cache for signal workers
async function writeDXYBlobsToCache(db, tfs) {
  for (const tf of tfs) {
    const rows = await db.prepare(`
      SELECT candle_time as time, open, high, low, close
      FROM dxy_candle_cache
      WHERE tf=?
      ORDER BY candle_time DESC
      LIMIT 50
    `).bind(tf).all();
    if (!rows.results || rows.results.length === 0) continue;
    await db.prepare(`
      INSERT OR REPLACE INTO candle_cache (symbol, tf, candles_json, fetched_at)
      VALUES ('DXY', ?, ?, ?)
    `).bind(tf, JSON.stringify(rows.results), new Date().toISOString()).run();
  }
}

// Cold start: seeds dxy_candle_cache from 21d of yahoo_candle_cache 1H data
async function seedDXYHistory(db, constituents, iceFactor) {
  const allCandles = {};
  for (const { symbol } of constituents) {
    const row = await db.prepare(
      'SELECT candles_json FROM yahoo_candle_cache WHERE symbol=? AND tf=?'
    ).bind(symbol, '1H').first();
    if (!row) return;
    allCandles[symbol] = JSON.parse(row.candles_json);
  }

  const timeSets = constituents.map(({ symbol }) =>
    new Set(allCandles[symbol].map(c => c.time))
  );
  const commonTimes = [...timeSets[0]].filter(t =>
    timeSets.every(s => s.has(t))
  ).sort((a, b) => b - a); // newest first

  if (commonTimes.length < 10) {
    await logWatchdog(db, 'warning',
      `seedDXYHistory: only ${commonTimes.length} common timestamps — aborting seed`);
    return;
  }

  const indexMaps = {};
  for (const { symbol } of constituents) {
    indexMaps[symbol] = new Map(allCandles[symbol].map(c => [c.time, c]));
  }

  const inserts = [];
  const now = new Date().toISOString();
  for (const t of commonTimes) {
    const latestMap = {};
    for (const { symbol } of constituents) {
      latestMap[symbol] = indexMaps[symbol].get(t);
    }
    const dxy = computeDXYCandle(constituents, latestMap, iceFactor, t);
    inserts.push(
      db.prepare(`
        INSERT OR IGNORE INTO dxy_candle_cache (tf, candle_time, open, high, low, close, created_at)
        VALUES ('1H', ?, ?, ?, ?, ?, ?)
      `).bind(t, dxy.open, dxy.high, dxy.low, dxy.close, now)
    );
  }

  await db.batch(inserts);
  await logWatchdog(db, 'info',
    `seedDXYHistory: seeded ${inserts.length} x 1H DXY candles from 21d history`);

  await synthesiseDXY4H(db);
  await synthesiseDXYDaily(db);
  await synthesiseDXYWeekly(db);

  await writeDXYBlobsToCache(db, ['1H', '4H', 'Daily', 'Weekly']);
}

// Runs at every 4H boundary — groups last 4 x 1H rows into one 4H candle
async function synthesiseDXY4H(db) {
  const rows = await db.prepare(`
    SELECT candle_time, open, high, low, close
    FROM dxy_candle_cache WHERE tf='1H'
    ORDER BY candle_time DESC LIMIT 4
  `).all();
  if (!rows.results || rows.results.length < 4) return;

  const candles = rows.results;
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
  `).bind(
    candle4H.time,
    candle4H.open, candle4H.high, candle4H.low, candle4H.close,
    new Date().toISOString()
  ).run();
}

// Runs at 17:00 NY daily close — groups current trading day's 1H rows
async function synthesiseDXYDaily(db) {
  const now = Date.now();
  const nyNowHour = getNewYorkHour(now);

  const tradingDayOpenMs = nyNowHour >= 17
    ? now - ((nyNowHour - 17) * 3600000)
    : now - ((nyNowHour + 7) * 3600000);

  const rows = await db.prepare(`
    SELECT candle_time, open, high, low, close
    FROM dxy_candle_cache WHERE tf='1H'
    AND candle_time >= ?
    ORDER BY candle_time ASC
  `).bind(tradingDayOpenMs).all();

  if (!rows.results || rows.results.length < 20) return;

  const candles = rows.results;
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
  `).bind(
    dailyCandle.time,
    dailyCandle.open, dailyCandle.high, dailyCandle.low, dailyCandle.close,
    new Date().toISOString()
  ).run();
}

// Runs at Friday 17:00 NY — groups current week's Daily rows
async function synthesiseDXYWeekly(db) {
  const rows = await db.prepare(`
    SELECT candle_time, open, high, low, close
    FROM dxy_candle_cache WHERE tf='Daily'
    ORDER BY candle_time DESC LIMIT 5
  `).all();
  if (!rows.results || rows.results.length < 5) return;

  const candles = [...rows.results].reverse(); // oldest first
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
  `).bind(
    weeklyCandle.time,
    weeklyCandle.open, weeklyCandle.high, weeklyCandle.low, weeklyCandle.close,
    new Date().toISOString()
  ).run();
}

// ============================================================
// Daily synthesis — forex trading day runs 17:00 NY → 16:00 NY the
// next calendar day. A day is complete once its 16:00 NY bar exists.
// ============================================================
function nyDateAndHour(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
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
        'SELECT candles_json FROM candle_cache WHERE symbol = ? AND tf = ?'
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
// Daily summary digest — watchdog_log activity in the last 24h
// ============================================================
async function sendWatchdogDailyDigest(env) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { results } = await env.DB.prepare(
    'SELECT event_type, COUNT(*) as count FROM watchdog_log WHERE created_at > ? GROUP BY event_type'
  ).bind(cutoff).all();

  if (!results || results.length === 0) {
    await sendWatchdogAlert(env,
      '📊 <b>Watchdog Daily Summary</b>\n⚠️ No watchdog_log entries in the last 24 hours — Watchdog may not be running.'
    );
    return;
  }

  const counts = { info: 0, warning: 0, error: 0 };
  for (const row of results) {
    if (row.event_type in counts) counts[row.event_type] = row.count;
  }

  const lastRun = await env.DB.prepare(
    'SELECT created_at FROM watchdog_log WHERE created_at > ? ORDER BY created_at DESC LIMIT 1'
  ).bind(cutoff).first();

  const message = `📊 <b>Watchdog Daily Summary</b>
Period: last 24 hours

✅ Normal runs: ${counts.info}
⚠️ Warnings: ${counts.warning}
🚨 Errors: ${counts.error}

Last run: ${lastRun?.created_at ?? 'unknown'}`;

  await sendWatchdogAlert(env, message);
}

// ============================================================
// Cron-gated orchestration
// ============================================================
async function runWatchdog(event, env) {
  _watchdogAlertEnv = env;

  const db     = env.DB;
  const now    = event.scheduledTime;
  const minute = new Date(now).getUTCMinutes();
  const hour   = new Date(now).getUTCHours();
  const nyHour = getNewYorkHour(now);
  const nyDay  = getNewYorkDay(now);

  // Daily summary digest — first tick after 08:00 UTC (plain UTC hour, not
  // the NY-adjusted one everything else in this function uses).
  if ((minute === 0 || minute < 15) && hour === 8) {
    await sendWatchdogDailyDigest(env);
  }

  // Forex 4H candles align to the NY trading-day boundary (17:00 NY — same
  // anchor daily synthesis uses), not a fixed UTC schedule. This set of NY
  // hours maps to a different set of UTC hours depending on EDT/EST —
  // that's intentional, not a bug: the goal is 6 fires per NY day, not 6
  // fires per UTC day.
  const NY_4H_BOUNDARIES = [17, 21, 1, 5, 9, 13];

  const signalSymbols = await getSignalSymbols(db);
  const keys = await getActiveKeys(db); // also logs if empty

  // Assign dedicated key per TF by label — stable against exhaustion-driven
  // index shifts (exhausted keys drop from the array, shifting [0],[1]…).
  const keyM15 = keys.find(k => k.label === 'Twelve Data Key 1');
  const keyM30 = keys.find(k => k.label === 'Twelve Data Key 2');
  const key1H  = keys.find(k => k.label === 'Twelve Data Key 3');
  const key4H  = keys.find(k => k.label === 'Twelve Data Key 4');

  // Build parallel fetch array — only push TFs that are due this tick.
  const fetches = [];

  fetches.push(
    fetchSignalAndStore(signalSymbols, 'M15', keyM15 ? [keyM15] : [], env)
  );

  if (minute % 30 === 0) {
    fetches.push(
      fetchSignalAndStore(signalSymbols, 'M30', keyM30 ? [keyM30] : [], env)
    );
  }

  if (minute === 0) {
    fetches.push(
      fetchSignalAndStore(signalSymbols, '1H', key1H ? [key1H] : [], env)
    );
  }

  if (minute === 0 && NY_4H_BOUNDARIES.includes(nyHour)) {
    fetches.push(
      fetchSignalAndStore(signalSymbols, '4H', key4H ? [key4H] : [], env)
    );
  }

  // Only the signal TF-fetch block is skipped when there's no signal pool —
  // breadth (Yahoo, unrelated to user_assets/configs) and the hourly tasks
  // below always run on schedule regardless.
  if (signalSymbols.length === 0) {
    await logWatchdog(db, 'warning', 'No active signal symbols — skipping');
  } else {
    await Promise.all(fetches);
  }

  if (minute === 0) {
    // Breadth from Yahoo — runs after signal fetches, no credit limits to
    // worry about, just yieldToRuntime() between symbols.
    await fetchBreadthFromYahoo(BREADTH_SYMBOLS, env);

    // DXY synthetic — must run after breadth so constituent 1H candles are
    // fresh in yahoo_candle_cache (EUR/USD, USD/JPY, GBP/USD, USD/CAD, USD/SEK,
    // USD/CHF all live in BREADTH_SYMBOLS and are written by fetchBreadthFromYahoo).
    await computeSyntheticDXY(db, now);

    // 4H synthesis — only at 4H boundary hours (NY 17/21/01/05/09/13)
    if (NY_4H_BOUNDARIES.includes(nyHour)) {
      await synthesiseDXY4H(db);
      await writeDXYBlobsToCache(db, ['4H']);
    }

    // Daily synthesis — only at 17:00 NY close
    if (nyHour === 17) {
      await synthesiseDXYDaily(db);
      await writeDXYBlobsToCache(db, ['Daily']);
    }

    // Weekly synthesis — only at Friday 17:00 NY
    if (nyHour === 17 && nyDay === 5) {
      await synthesiseDXYWeekly(db);
      await writeDXYBlobsToCache(db, ['Weekly']);
    }

    // Always write 1H blob after every run
    await writeDXYBlobsToCache(db, ['1H']);

    // Daily/weekly synthesis includes DXY so its daily/weekly candles are
    // built alongside signal-symbol candles. Market Breadth still reads
    // candle_cache 1H directly; daily_candle_cache/weekly_candle_cache are
    // only needed for DXY chart/detection.
    await attemptDailySynthesis([...signalSymbols, 'DXY'], env);

    await cleanupApiCallLog(db);

    if (nyDay === 5 && nyHour === 17) {
      await attemptWeeklySynthesis([...signalSymbols, 'DXY'], env);
    }
  }
}

// ============================================================
// Export
// ============================================================
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ ok: true, worker: 'ebp-watchdog', ts: new Date().toISOString() });
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
