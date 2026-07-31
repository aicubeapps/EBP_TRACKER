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
      const raw    = await fetchYahooFinance(symbol, '1H', 50);
      const closed = getClosedCandles(raw, INTERVAL_MS['1H']);
      if (closed.length >= 20) {
        await writeCandleCache(env.DB, symbol, '1H', closed);
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
// Synthetic DXY — ICE formula computed from 1H breadth candles.
// Weights: EUR/USD −0.576, USD/JPY +0.136, GBP/USD −0.119,
//          USD/CAD +0.091, USD/SEK +0.042, USD/CHF +0.036
// Called after fetchBreadthFromYahoo so constituent candles are fresh.
// ============================================================
async function computeSyntheticDXY(env) {
  const CONSTITUENTS = ['EUR/USD', 'USD/JPY', 'GBP/USD', 'USD/CAD', 'USD/SEK', 'USD/CHF'];
  const WEIGHTS = {
    'EUR/USD': -0.576, 'USD/JPY':  0.136, 'GBP/USD': -0.119,
    'USD/CAD':  0.091, 'USD/SEK':  0.042, 'USD/CHF':  0.036,
  };
  const K = 50.14348112;

  const byTime = {};
  for (const sym of CONSTITUENTS) {
    const row = await env.DB.prepare(
      'SELECT candles_json FROM candle_cache WHERE symbol = ? AND tf = ?'
    ).bind(sym, '1H').first();
    if (!row) {
      await logWatchdog(env.DB, 'warning', `computeSyntheticDXY: missing 1H candles for ${sym} — skipping`);
      return;
    }
    for (const c of JSON.parse(row.candles_json)) {
      if (!byTime[c.time]) byTime[c.time] = {};
      byTime[c.time][sym] = c;
    }
  }

  // For each OHLC field, compute DXY using the appropriate price from each
  // constituent. For high: use low of negatively-weighted pairs (they pull DXY
  // down when high) and high of positively-weighted pairs. Reverse for low.
  const dxy = (prices, getVal) => {
    let v = K;
    for (const sym of CONSTITUENTS) v *= Math.pow(getVal(prices[sym], WEIGHTS[sym]), WEIGHTS[sym]);
    return parseFloat(v.toFixed(5));
  };

  const candles = Object.entries(byTime)
    .filter(([, p]) => CONSTITUENTS.every(s => p[s]))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([t, p]) => ({
      time:  Number(t),
      open:  dxy(p, c => c.open),
      close: dxy(p, c => c.close),
      high:  dxy(p, (c, w) => w < 0 ? c.low  : c.high),
      low:   dxy(p, (c, w) => w < 0 ? c.high : c.low),
    }));

  if (candles.length < 20) {
    await logWatchdog(env.DB, 'warning', `computeSyntheticDXY: only ${candles.length} common candles — skipping`);
    return;
  }

  await writeCandleCache(env.DB, 'DXY', '1H', candles);
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
// Cron-gated orchestration
// ============================================================
async function runWatchdog(event, env) {
  const db     = env.DB;
  const minute = new Date(event.scheduledTime).getUTCMinutes();
  const nyHour = getNewYorkHour(event.scheduledTime);
  const nyDay  = getNewYorkDay(event.scheduledTime);

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
    // fresh (EUR/USD, USD/JPY, GBP/USD, USD/CAD, USD/SEK, USD/CHF all live
    // in BREADTH_SYMBOLS and are written by fetchBreadthFromYahoo above).
    await computeSyntheticDXY(env);

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
        await logWatchdog(env.DB, 'error', `Unhandled scheduled() error: ${e.message}`);
      })
    );
  },
};
