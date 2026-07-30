function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
var MAJOR_PAIRS = [
  ["EUR/USD", "EUR", "USD"],
  ["GBP/USD", "GBP", "USD"],
  ["USD/JPY", "USD", "JPY"],
  ["USD/CHF", "USD", "CHF"],
  ["USD/CAD", "USD", "CAD"],
  ["AUD/USD", "AUD", "USD"],
  ["NZD/USD", "NZD", "USD"],
  ["EUR/GBP", "EUR", "GBP"],
  ["EUR/JPY", "EUR", "JPY"],
  ["EUR/CHF", "EUR", "CHF"],
  ["EUR/CAD", "EUR", "CAD"],
  ["EUR/AUD", "EUR", "AUD"],
  ["EUR/NZD", "EUR", "NZD"],
  ["GBP/JPY", "GBP", "JPY"],
  ["GBP/CHF", "GBP", "CHF"],
  ["GBP/CAD", "GBP", "CAD"],
  ["GBP/AUD", "GBP", "AUD"],
  ["GBP/NZD", "GBP", "NZD"],
  ["CHF/JPY", "CHF", "JPY"],
  ["CAD/JPY", "CAD", "JPY"],
  ["AUD/JPY", "AUD", "JPY"],
  ["NZD/JPY", "NZD", "JPY"],
  ["AUD/CAD", "AUD", "CAD"],
  ["AUD/CHF", "AUD", "CHF"],
  ["AUD/NZD", "AUD", "NZD"],
  ["NZD/CAD", "NZD", "CAD"],
  ["NZD/CHF", "NZD", "CHF"],
  ["CAD/CHF", "CAD", "CHF"]
];
var BREADTH_SYMBOLS = MAJOR_PAIRS.map(([pair]) => pair);
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
  return (results ?? []).map((r) => r.symbol);
}
var TF_TO_INTERVAL = { M15: "15min", M30: "30min", "1H": "1h", "4H": "4h" };
var INTERVAL_MS = {
  "M5": 5 * 60 * 1e3,
  "M15": 15 * 60 * 1e3,
  "M30": 30 * 60 * 1e3,
  "1H": 60 * 60 * 1e3,
  "4H": 4 * 60 * 60 * 1e3,
  "D": 24 * 60 * 60 * 1e3,
  "W": 7 * 24 * 60 * 60 * 1e3
};
function getClosedCandles(candles, intervalMs) {
  if (!intervalMs) return candles;
  const now = Date.now();
  return candles.filter((c) => {
    const openMs = typeof c.time === "number" ? c.time : new Date(c.time).getTime();
    return openMs + intervalMs <= now;
  });
}
function nyLocalStringToUTCms(str) {
  const iso = str.includes(" ") ? str.replace(" ", "T") : `${str}T00:00:00`;
  const naiveMs = Date.parse(`${iso}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset"
  }).formatToParts(new Date(naiveMs));
  const offsetStr = parts.find((p) => p.type === "timeZoneName").value;
  const offsetHours = parseInt(offsetStr.replace("GMT", ""));
  return naiveMs - offsetHours * 3600 * 1e3;
}
function nextMidnightUTC() {
  const now = /* @__PURE__ */ new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
}
async function resetExhaustedKeys(db) {
  const now = Date.now();
  await db.prepare(
    `UPDATE api_key_state
     SET exhausted=0, calls_today=0, exhausted_at=NULL, reset_at=?
     WHERE reset_at < ?`
  ).bind(nextMidnightUTC(), now).run();
}
async function cleanupApiCallLog(db) {
  await db.prepare(
    `DELETE FROM api_call_log WHERE called_at < ?`
  ).bind(Date.now() - 2 * 24 * 60 * 60 * 1e3).run();
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
  for (const row of results ?? []) {
    if (row.exhausted === 0) {
      return { keyName: row.id, apiKey: row.key_value, label: row.label };
    }
  }
  return null;
}
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
    await logWatchdog(db, "error", "No active Twelve Data keys available");
  }
  return keys;
}
async function markKeyExhausted(db, keyName) {
  const now = Date.now();
  await db.prepare(
    `UPDATE api_key_state SET exhausted=1, exhausted_at=?, reset_at=? WHERE key_name=?`
  ).bind(now, nextMidnightUTC(), keyName).run();
  console.warn(`[ROTATION] ${keyName} exhausted \u2014 rotating to next key`);
}
async function incrementKeyCallCount(db, keyName) {
  await db.prepare(
    `UPDATE api_key_state SET calls_today=calls_today+1 WHERE key_name=?`
  ).bind(keyName).run();
}
function isTwelveDataExhausted(data) {
  if (data?.status === "error" && data?.message?.toLowerCase().includes("run out")) return true;
  if (data?.status === "error" && data?.message?.toLowerCase().includes("api credits")) return true;
  return false;
}
async function logApiCall(db, source, symbol, timeframe, success = 1) {
  try {
    await db.prepare(
      "INSERT INTO api_call_log (id, source, symbol, timeframe, called_at, success) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), source, symbol, timeframe, Date.now(), success).run();
  } catch {
  }
}
function toYahooSymbol(symbol) {
  const overrides = {
    "XAU/USD": "GC=F",
    "XAG/USD": "SI=F",
    "WTI/USD": "CL=F",
    "BRENT/USD": "BZ=F",
    "SPX": "^GSPC",
    "DJI": "^DJI",
    "NDX": "^NDX",
    "NIFTY": "^NSEI",
    "SENSEX": "^BSESN"
  };
  if (overrides[symbol]) return overrides[symbol];
  if (symbol.includes("/")) {
    const [base, quote] = symbol.split("/");
    return `${base}${quote}=X`;
  }
  return symbol;
}
function toYahooInterval(tf) {
  const map = {
    "M5": "5m",
    "M15": "15m",
    "M30": "30m",
    "1H": "1h",
    "4H": "1h",
    "D": "1d",
    "W": "1wk"
  };
  return map[tf] ?? "1h";
}
async function fetchYahooFinance(symbol, tf, outputSize = 50) {
  const yahooSymbol = toYahooSymbol(symbol);
  const interval = toYahooInterval(tf);
  const rangeMap = {
    "M5": "1d",
    "M15": "5d",
    "M30": "5d",
    "1H": "5d",
    "4H": "60d",
    "D": "1mo",
    "W": "3mo"
  };
  const range = rangeMap[tf] ?? "5d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: no data for ${symbol}`);
  const timestamps = result.timestamp;
  const ohlc = result.indicators.quote[0];
  const candles = [];
  for (let i = timestamps.length - 1; i >= 0 && candles.length < outputSize; i--) {
    if (ohlc.close[i] == null) continue;
    candles.push({
      open: ohlc.open[i],
      high: ohlc.high[i],
      low: ohlc.low[i],
      close: ohlc.close[i],
      time: timestamps[i] * 1e3
    });
  }
  return candles;
}
async function yieldToRuntime() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function logWatchdog(db, eventType, message) {
  try {
    await db.prepare(
      "INSERT INTO watchdog_log (event_type, message, created_at) VALUES (?, ?, ?)"
    ).bind(eventType, message, (/* @__PURE__ */ new Date()).toISOString()).run();
  } catch (e) {
    console.error("[WATCHDOG_LOG] failed to write log:", e.message);
  }
}
var CHUNK_SIZE = 7;
async function fetchChunkWithKey(chunk, tf, key, env) {
  const resultMap = /* @__PURE__ */ new Map();
  const interval = TF_TO_INTERVAL[tf];
  const joined = chunk.join(",");
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(joined)}&interval=${interval}&outputsize=50&timezone=America/New_York&order=DESC&apikey=${key.key_value}`;
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      await logWatchdog(env.DB, "warning", `TF=${tf} key=${key.key_name} chunk=${chunk.join(",")} got 429 \u2014 skipped`);
      return resultMap;
    }
    if (!res.ok) {
      await logWatchdog(env.DB, "error", `TF=${tf} key=${key.key_name} chunk=${chunk.join(",")} got HTTP ${res.status} \u2014 skipped`);
      return resultMap;
    }
    const data = await res.json();
    const bySymbol = chunk.length === 1 ? { [chunk[0]]: data } : data;
    const entries = Object.values(bySymbol);
    if (entries.length > 0 && entries.every((v) => isTwelveDataExhausted(v))) {
      await markKeyExhausted(env.DB, key.key_name);
      await logWatchdog(env.DB, "error", `${key.label} exhausted (daily credits) for chunk ${tf}`);
      return resultMap;
    }
    await ensureKeyStateRow(env.DB, key.key_name);
    await incrementKeyCallCount(env.DB, key.key_name);
    await logApiCall(env.DB, key.key_name, `chunk:${chunk.length}`, tf, 1);
    const creditsLeft = res.headers.get("api-credits-left");
    if (creditsLeft !== null && parseInt(creditsLeft, 10) === 0) {
      await markKeyExhausted(env.DB, key.key_name);
    }
    for (const symbol of chunk) {
      const entry = bySymbol[symbol];
      if (!entry || entry.status === "error" || !entry.values) {
        await logWatchdog(env.DB, "warning", `${symbol} ${tf}: Twelve Data symbol error \u2014 ${entry?.message ?? "no data"}`);
        continue;
      }
      const raw = entry.values.map((v) => ({
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        time: nyLocalStringToUTCms(v.datetime)
      }));
      resultMap.set(symbol, getClosedCandles(raw, INTERVAL_MS[tf]));
    }
  } catch (e) {
    await logWatchdog(env.DB, "error", `TF=${tf} key=${key.key_name} chunk fetch error: ${e.message}`);
  }
  return resultMap;
}
async function fetchSignalTF(symbols, tf, keys, env) {
  const resultMap = /* @__PURE__ */ new Map();
  if (!symbols.length || !keys.length) return resultMap;
  const chunks = [];
  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    chunks.push(symbols.slice(i, i + CHUNK_SIZE));
  }
  let assignedChunks = chunks;
  if (chunks.length > keys.length) {
    const skipped = chunks.slice(keys.length);
    const skippedSymbols = skipped.flat();
    await logWatchdog(
      env.DB,
      "warning",
      `TF=${tf} has ${chunks.length} chunks but only ${keys.length} keys \u2014 ${skipped.length} chunks skipped. Skipped symbols: ${skippedSymbols.join(",")}`
    );
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
async function writeCandleCache(db, symbol, tf, candles) {
  await db.prepare(`
    INSERT OR REPLACE INTO candle_cache (symbol, tf, candles_json, fetched_at)
    VALUES (?, ?, ?, ?)
  `).bind(symbol, tf, JSON.stringify(candles), (/* @__PURE__ */ new Date()).toISOString()).run();
}
async function fetchSignalAndStore(symbols, tf, keys, env) {
  if (!symbols.length) return;
  let resultMap;
  const active = await getActiveTwelveDataKey(env.DB);
  if (!active) {
    resultMap = /* @__PURE__ */ new Map();
    await logWatchdog(env.DB, "error", `All Twelve Data keys exhausted \u2014 falling back to Yahoo for ${tf} (${symbols.length} signal symbols)`);
    for (const symbol of symbols) {
      try {
        const raw = await fetchYahooFinance(symbol, tf, 50);
        const closed = getClosedCandles(raw, INTERVAL_MS[tf]);
        resultMap.set(symbol, closed);
        await logApiCall(env.DB, "yahoo", symbol, tf, 1);
      } catch (e) {
        await logWatchdog(env.DB, "error", `Symbol fetch failure ${symbol} ${tf}: Yahoo fallback also failed \u2014 ${e.message}`);
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
      await logWatchdog(env.DB, "warning", `${symbol} ${tf}: only ${candles.length} closed candles (<20) \u2014 skipping D1 write`);
    }
    await yieldToRuntime();
  }
}
async function fetchBreadthFromYahoo(symbols, env) {
  let successCount = 0;
  for (const symbol of symbols) {
    try {
      const raw = await fetchYahooFinance(symbol, "1H", 50);
      const closed = getClosedCandles(raw, INTERVAL_MS["1H"]);
      if (closed.length >= 20) {
        await writeCandleCache(env.DB, symbol, "1H", closed);
        successCount++;
      } else {
        await logWatchdog(env.DB, "warning", `${symbol} 1H (breadth): only ${closed.length} closed candles (<20) \u2014 skipping D1 write`);
      }
    } catch (e) {
      await logWatchdog(env.DB, "error", `Breadth fetch failed for ${symbol}: ${e.message}`);
    }
    await yieldToRuntime();
  }
  await logWatchdog(env.DB, "info", `Breadth fetch complete: ${successCount}/${symbols.length} symbols written`);
}
function nyDateAndHour(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  }).formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  return { date: `${map.year}-${map.month}-${map.day}`, hour };
}
function getNYOffset(utcMs) {
  const date = new Date(utcMs);
  const year = date.getUTCFullYear();
  const marchDate = new Date(Date.UTC(year, 2, 1));
  const marchDay = marchDate.getUTCDay();
  const dstStart = new Date(Date.UTC(year, 2, marchDay === 0 ? 8 : 15 - marchDay));
  const novDate = new Date(Date.UTC(year, 10, 1));
  const novDay = novDate.getUTCDay();
  const dstEnd = new Date(Date.UTC(year, 10, novDay === 0 ? 1 : 8 - novDay));
  const isEDT = date >= dstStart && date < dstEnd;
  return isEDT ? -4 : -5;
}
function getNewYorkHour(utcMs) {
  const nyMs = utcMs + getNYOffset(utcMs) * 60 * 60 * 1e3;
  return new Date(nyMs).getUTCHours();
}
function getNewYorkDay(utcMs) {
  const nyMs = utcMs + getNYOffset(utcMs) * 60 * 60 * 1e3;
  return new Date(nyMs).getUTCDay();
}
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function groupHourlyByTradingDay(candles) {
  const groups = /* @__PURE__ */ new Map();
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
        "SELECT candles_json FROM candle_cache WHERE symbol = ? AND tf = ?"
      ).bind(symbol, "1H").first();
      if (row) {
        const hourly = JSON.parse(row.candles_json);
        const groups = groupHourlyByTradingDay(hourly);
        for (const [dateNy, bars] of groups) {
          const dayComplete = bars.some((b) => b.nyHour === 16);
          if (!dayComplete) continue;
          const sorted = [...bars].sort((a, b) => a.time - b.time);
          const open = sorted[0].open;
          const high = Math.max(...sorted.map((b) => b.high));
          const low = Math.min(...sorted.map((b) => b.low));
          const close = sorted[sorted.length - 1].close;
          await env.DB.prepare(`
            INSERT OR IGNORE INTO daily_candle_cache
            (symbol, date_ny, open, high, low, close, synthesised_at)
            VALUES (?,?,?,?,?,?,?)
          `).bind(symbol, dateNy, open, high, low, close, (/* @__PURE__ */ new Date()).toISOString()).run();
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
      await logWatchdog(env.DB, "error", `Daily synthesis failed for ${symbol}: ${e.message}`);
    }
    await yieldToRuntime();
  }
}
function getISOWeekMonday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diffToMonday);
  return dt.toISOString().slice(0, 10);
}
async function attemptWeeklySynthesis(symbols, env) {
  for (const symbol of symbols) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT date_ny, open, high, low, close FROM daily_candle_cache WHERE symbol = ? ORDER BY date_ny DESC LIMIT 7"
      ).bind(symbol).all();
      const rows = results ?? [];
      if (rows.length) {
        const groups = /* @__PURE__ */ new Map();
        for (const r of rows) {
          const monday = getISOWeekMonday(r.date_ny);
          if (!groups.has(monday)) groups.set(monday, []);
          groups.get(monday).push(r);
        }
        for (const [weekStart, bars] of groups) {
          const fridayDate = addDaysToDateStr(weekStart, 4);
          const mondayBar = bars.find((b) => b.date_ny === weekStart);
          const fridayBar = bars.find((b) => b.date_ny === fridayDate);
          if (!mondayBar || !fridayBar) continue;
          const open = mondayBar.open;
          const high = Math.max(...bars.map((b) => b.high));
          const low = Math.min(...bars.map((b) => b.low));
          const close = fridayBar.close;
          await env.DB.prepare(`
            INSERT OR IGNORE INTO weekly_candle_cache
            (symbol, week_start_ny, week_end_ny, open, high, low, close, synthesised_at)
            VALUES (?,?,?,?,?,?,?,?)
          `).bind(symbol, weekStart, fridayDate, open, high, low, close, (/* @__PURE__ */ new Date()).toISOString()).run();
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
      await logWatchdog(env.DB, "error", `Weekly synthesis failed for ${symbol}: ${e.message}`);
    }
    await yieldToRuntime();
  }
}
async function runWatchdog(event, env) {
  const db = env.DB;
  const minute = new Date(event.scheduledTime).getUTCMinutes();
  const nyHour = getNewYorkHour(event.scheduledTime);
  const nyDay = getNewYorkDay(event.scheduledTime);
  const NY_4H_BOUNDARIES = [17, 21, 1, 5, 9, 13];
  const signalSymbols = await getSignalSymbols(db);
  const keys = await getActiveKeys(db);
  const tfsToFetch = ["M15"];
  if (minute % 30 === 0) tfsToFetch.push("M30");
  if (minute === 0) tfsToFetch.push("1H");
  if (minute === 0 && NY_4H_BOUNDARIES.includes(nyHour)) {
    tfsToFetch.push("4H");
  }
  if (!signalSymbols.length) {
    await logWatchdog(db, "warning", "No active signal symbols found \u2014 skipping signal fetch this tick");
  } else {
    for (let i = 0; i < tfsToFetch.length; i++) {
      await fetchSignalAndStore(signalSymbols, tfsToFetch[i], keys, env);
      if (i < tfsToFetch.length - 1) {
        await sleep(65e3);
      }
    }
  }
  if (minute === 0) {
    await fetchBreadthFromYahoo(BREADTH_SYMBOLS, env);
    await attemptDailySynthesis(signalSymbols, env);
    await cleanupApiCallLog(db);
    if (nyDay === 5 && nyHour === 17) {
      await attemptWeeklySynthesis(signalSymbols, env);
    }
  }
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, worker: "ebp-watchdog", ts: (/* @__PURE__ */ new Date()).toISOString() });
    }
    return json({ error: "Not found" }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runWatchdog(event, env).catch(async (e) => {
        console.error("[WATCHDOG] Unhandled error:", e.message);
        await logWatchdog(env.DB, "error", `Unhandled scheduled() error: ${e.message}`);
      })
    );
  }
};

