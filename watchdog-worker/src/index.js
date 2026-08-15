// ============================================================
// EBP Watchdog Worker — Centralised Twelve Data Candle Fetcher
// Zero dependencies — pure Cloudflare Workers runtime only.
//
// Sole Twelve Data caller for all forex/crypto/commodity candle
// data. EBP Worker and Sweep Worker read candle_cache (D1) only.
//
// Single native cron (*/15 * * * *) — all TF fetching is gated
// inside one scheduled() handler; no per-TF cron expressions.
//
// Breadth/DXY/synthesis/digest ETL lives in market-breath worker.
// External watchdog health check (POST /health/watchdog-check) also
// moved to market-breath worker 2026-08-15 — this worker no longer
// holds WATCHDOG_BOT_TOKEN/WATCHDOG_ADMIN_CHAT_ID.
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

async function ensureKeyStateRow(db, keyName) {
  await db.prepare(
    `INSERT OR IGNORE INTO api_key_state (key_name, exhausted, calls_today, reset_at) VALUES (?, 0, 0, 0)`
  ).bind(keyName).run();
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
// watchdog_log — only failures get logged; successful writes
// are not (too verbose for a 15-min cron × dozens of symbols).
// DB-only — this worker no longer holds WATCHDOG_BOT_TOKEN (moved to
// market-breath 2026-08-14), so error/warning Telegram alerting was
// stripped 2026-08-15 rather than left silently broken.
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
// market-breath worker). A 429 here is a per-minute rate limit on that
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
// architecture. Writes each valid result to D1.
async function fetchSignalAndStore(symbols, tf, keys, env) {
  if (!symbols.length) return;

  const resultMap = await fetchSignalTF(symbols, tf, keys, env);

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

// Manual DST calculation for the 4H cron boundary check — matches the same
// "2nd Sunday of March / 1st Sunday of November" pattern already used in
// worker/src/ebp-worker.js's deriveSession(). Note: comparing against
// midnight UTC of the transition date means there's a ~6-7 hour window on
// the two transition days each year where this is off by one hour — an
// accepted, pre-existing tradeoff shared with deriveSession().
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

// ============================================================
// Cron-gated orchestration
// ============================================================
async function runWatchdog(event, env) {
  const db = env.DB;
  // Breadth/DXY/synthesis/digest ETL moved to market-breath worker.
  // This native CF cron tick is a near-zero-CPU heartbeat only.
  await logWatchdog(db, 'info', 'Watchdog scheduled tick — heartbeat');
}

// ============================================================
// POST /cron/candle-fetch — signal-symbol Twelve Data ETL, extracted
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
// Export
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, worker: 'ebp-watchdog', ts: new Date().toISOString() });
    }

    // Signal-symbol candle ETL — extracted from the native scheduled() cron
    // to keep that handler's CPU time near-zero. cron-job.org, every 15 min.
    if (url.pathname === '/cron/candle-fetch' && request.method === 'POST') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) {
        return json({ error: 'Forbidden' }, 401);
      }
      return await handleCandleFetchCron(env);
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
