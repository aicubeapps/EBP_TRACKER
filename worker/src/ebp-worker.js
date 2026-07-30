var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/ebp-worker.js
var ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://ebp-tracker.pages.dev"
];
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin)
    }
  });
}
function getOrigin(request) {
  return request.headers.get("Origin") ?? "";
}
function journalJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
var Router = class {
  static {
  }
  constructor() {
    this.routes = [];
  }
  add(method, path, ...handlers) {
    this.routes.push({ method, path, handlers });
  }
  get(path, ...handlers) {
    this.add("GET", path, ...handlers);
  }
  post(path, ...handlers) {
    this.add("POST", path, ...handlers);
  }
  patch(path, ...handlers) {
    this.add("PATCH", path, ...handlers);
  }
  delete(path, ...handlers) {
    this.add("DELETE", path, ...handlers);
  }
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.path, pathname);
      if (params !== null) return { handlers: route.handlers, params };
    }
    return null;
  }
};
function matchPath(pattern, pathname) {
  const patParts = pattern.split("/");
  const urlParts = pathname.split("/");
  if (patParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(":")) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}
function calcTTradesBias({ bar1, bar2 }) {
  const c0 = bar1.close;
  const h0 = bar1.high;
  const l0 = bar1.low;
  const prevH = bar2.high;
  const prevL = bar2.low;
  const sweptH = h0 > prevH && c0 <= prevH;
  const sweptL = l0 < prevL && c0 >= prevL;
  const insideD = h0 <= prevH && l0 >= prevL;
  const outsideD = h0 > prevH && l0 < prevL;
  const aboveH = c0 > prevH;
  const belowL = c0 < prevL;
  let closure;
  if (outsideD) closure = "outside_bar";
  else if (insideD) closure = "inside_bar";
  else if (sweptH) closure = "swept_high_closed_inside";
  else if (sweptL) closure = "swept_low_closed_inside";
  else if (aboveH) closure = "above_prev_high";
  else if (belowL) closure = "below_prev_low";
  else closure = "none";
  const rng = h0 - l0;
  const closePos = rng !== 0 ? (c0 - l0) / rng * 100 : 50;
  let bias;
  if (closure === "above_prev_high" || closure === "swept_low_closed_inside") {
    bias = "bullish";
  } else if (closure === "below_prev_low" || closure === "swept_high_closed_inside") {
    bias = "bearish";
  } else if (closure === "outside_bar") {
    bias = closePos >= 50 ? "bullish" : "bearish";
  } else {
    bias = "neutral";
  }
  return { bias, closure, closePos };
}
var BIAS_SOURCE = {
  ebp: { "M15": "4H", "1H": "D", "4H": "W", "D": "W", "W": null },
  sweep: { "M5": "1H", "M15": "1H", "M30": "4H", "1H": "D", "4H": "W" },
  template: { "W": null, "D": "W", "4H": "D", "1H": "4H" }
};
function getHTFBiasLabel(biasTF) {
  const map = { "4H": "4H HTF bias", "D": "1D HTF bias", "W": "1W HTF bias", "1H": "1H HTF bias" };
  return map[biasTF] ?? `${biasTF} HTF bias`;
}
var VALID_HTF_OVERRIDES = {
  "1H": ["4H", "D"],
  "4H": ["D", "W"]
};
function resolveHTF(signalType, tf, htfOverride) {
  if (htfOverride) return htfOverride;
  return BIAS_SOURCE[signalType][tf] ?? null;
}
function getEffectiveBias(biasTF, biasCache, biasOverrides) {
  if (!biasTF) return "neutral";
  const override = biasOverrides?.[biasTF];
  if (override && override !== "auto") return override;
  return biasCache?.[biasTF]?.bias ?? "neutral";
}
async function writeBiasCache(db, symbol, biasTF, biasResult) {
  await db.prepare(`
    INSERT OR REPLACE INTO bias_cache
    (symbol, timeframe, bias, closure_type, close_pos, bar1_time, updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).bind(
    symbol,
    biasTF,
    biasResult.bias,
    biasResult.closure,
    biasResult.closePos ?? null,
    biasResult.bar1Time,
    Date.now()
  ).run();
}
async function initiateT3Chain(db, userId, assetId, symbol, direction, htfTf, ltf, windowMins, signalId) {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO chain_state
    (id,user_id,asset_id,symbol,template,direction,current_step,htf_tf,ltf,htf_signal_time,expires_at,created_at,htf_signal_id)
    VALUES (?,?,?,?,?,?,2,?,?,?,?,?,?)
  `).bind(
    crypto.randomUUID(),
    userId,
    assetId,
    symbol,
    "t3",
    direction,
    htfTf,
    ltf,
    now,
    now + windowMins * 60 * 1e3,
    now,
    signalId
  ).run();
}
function formatT3Alert(symbol, htf, ltf, direction, session, price, signalId, step) {
  const emoji = direction === "bullish" ? "\u{1F7E2}" : "\u{1F534}";
  const dirLabel = direction === "bullish" ? "BULL" : "BEAR";
  const stepLabel = "/S" + step;
  return [
    "\u{1F3AF} T3 Chain \u2014 " + symbol,
    "Step: S" + step + " of 3",
    "HTF: " + htf + " EBP \u2192 LTF: " + ltf + " Sweep \u2192 LTF: " + ltf + " MSS",
    "Direction: " + emoji + " " + dirLabel,
    "Session: " + session,
    "Price: " + price,
    "Signal ID: " + signalId + stepLabel
  ].join("\n");
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
async function getCandlesFromCache(symbol, tf, env) {
  const row = await env.DB.prepare(
    "SELECT candles_json, fetched_at FROM candle_cache WHERE symbol = ? AND tf = ?"
  ).bind(symbol, tf).first();
  if (!row) return null;
  const intervalMs = { M15: 15 * 60 * 1e3, M30: 30 * 60 * 1e3, "1H": 60 * 60 * 1e3, "4H": 4 * 60 * 60 * 1e3 };
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (age > 2 * intervalMs[tf]) {
    console.warn(`Stale cache for ${symbol} ${tf}: ${age}ms old`);
    return null;
  }
  return JSON.parse(row.candles_json);
}
function nyDateAtHourToUTCms(dateStr, hour) {
  const naiveMs = Date.parse(`${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset"
  }).formatToParts(new Date(naiveMs));
  const offsetStr = parts.find((p) => p.type === "timeZoneName").value;
  const offsetHours = parseInt(offsetStr.replace("GMT", ""));
  return naiveMs - offsetHours * 3600 * 1e3;
}
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
async function getDailyCandlesFromCache(symbol, env) {
  const { results } = await env.DB.prepare(
    "SELECT date_ny, open, high, low, close FROM daily_candle_cache WHERE symbol = ? ORDER BY date_ny DESC LIMIT 5"
  ).bind(symbol).all();
  return (results ?? []).map((r) => ({
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    time: nyDateAtHourToUTCms(addDaysToDateStr(r.date_ny, -1), 17)
  }));
}
async function getWeeklyCandlesFromCache(symbol, env) {
  const { results } = await env.DB.prepare(
    "SELECT week_start_ny, week_end_ny, open, high, low, close FROM weekly_candle_cache WHERE symbol = ? ORDER BY week_start_ny DESC LIMIT 5"
  ).bind(symbol).all();
  return (results ?? []).map((r) => ({
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    time: nyDateAtHourToUTCms(addDaysToDateStr(r.week_start_ny, -1), 17)
  }));
}
function normaliseSymbol(symbol) {
  if (!symbol) return symbol;
  if (symbol.includes("/")) return symbol;
  const FOREX_BASES = ["EUR", "GBP", "USD", "AUD", "NZD", "CAD", "CHF", "JPY", "XAU", "XAG", "BTC", "ETH", "SOL"];
  const FOREX_QUOTES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"];
  const upper = symbol.toUpperCase();
  for (const base of FOREX_BASES) {
    for (const quote of FOREX_QUOTES) {
      if (upper === base + quote && base !== quote) {
        return `${base}/${quote}`;
      }
    }
  }
  return symbol;
}
function guessAssetType(symbol) {
  if (symbol.includes("/")) {
    const base = symbol.split("/")[0];
    if (["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "BNB"].includes(base)) return "crypto";
    if (["XAU", "XAG", "WTI", "BRENT"].includes(base)) return "commodity";
    return "forex";
  }
  if (symbol.endsWith(".NS") || symbol.endsWith(".BSE")) return "nse";
  if (["NIFTY", "SENSEX", "SPX", "DJI", "NDX"].includes(symbol)) return "index";
  return "forex";
}
async function validateSymbol(symbol, apiKey) {
  try {
    const yahooSymbol = toYahooSymbol(symbol);
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + yahooSymbol + "?interval=1d&range=5d";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (result?.meta?.symbol) return { valid: true, source: "yahoo", instrumentType: result.meta.instrumentType ?? null };
  } catch (e) {
    console.warn("Yahoo validation failed:", e.message);
  }
  return { valid: true, source: "fallback", instrumentType: null };
}
async function sendTelegramMessage(botToken, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data;
}
function fmtNY(ts) {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  });
}
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
  if (nyTime >= 20) return "Asian";
  if (nyTime >= 7 && nyTime < 10) return "New York";
  if (nyTime >= 2 && nyTime < 5) return "London";
  return "Off-hours";
}
function formatEBPAlert({ symbol, tf, direction, candleTime, trendBias, trendAligned, sweptLevel, closedLevel, signalId, biasTF }) {
  const emoji = direction === "bullish" ? "\u{1F7E2}" : "\u{1F534}";
  const label = direction === "bullish" ? "BULLISH EBP" : "BEARISH EBP";
  const alignMark = trendAligned ? "\u2705" : "\u26A0\uFE0F No Trend Filter";
  const swept = direction === "bullish" ? "Low swept" : "High swept";
  const closed = direction === "bullish" ? "Closed above body" : "Closed below body";
  return `${emoji} <b>${label} \u2014 ${symbol}</b>
\u23F1 Timeframe: ${tf}
\u{1F550} Candle: ${fmtNY(candleTime)} NY
\u{1F4CA} Trend: ${trendBias} (${getHTFBiasLabel(biasTF)}) ${alignMark}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
${swept}: ${sweptLevel}
${closed}: ${closedLevel}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${signalId ? `
\u{1F517} Signal ID: ${signalId}` : ""}
<i>EBP Tracker</i>`;
}
function detectEBP(candles) {
  if (!candles || candles.length < 2) return null;
  const bar0 = candles[0];
  const bar1 = candles[1];
  const prevBodyHigh = Math.max(bar1.open, bar1.close);
  const prevBodyLow = Math.min(bar1.open, bar1.close);
  const bullEBP = bar0.low < bar1.low && bar0.close > prevBodyHigh;
  const bearEBP = bar0.high > bar1.high && bar0.close < prevBodyLow;
  if (!bullEBP && !bearEBP) return null;
  return {
    direction: bullEBP ? "bullish" : "bearish",
    candleTime: bar0.time,
    sweptLevel: bullEBP ? bar1.low : bar1.high,
    closedLevel: bar0.close
  };
}
function detectSweep(candles) {
  if (!candles || candles.length < 2) return null;
  const bar0 = candles[0];
  const bar1 = candles[1];
  const bullSweep = bar0.low < bar1.low && bar0.close > bar1.low;
  const bearSweep = bar0.high > bar1.high && bar0.close < bar1.high;
  if (!bullSweep && !bearSweep) return null;
  return {
    direction: bullSweep ? "bullish" : "bearish",
    candleTime: bar0.time,
    sweptLevel: bullSweep ? bar1.low : bar1.high,
    closedInsideLevel: bar0.close,
    prevHigh: bar1.high,
    prevLow: bar1.low
  };
}
function detectFVG(candles) {
  const [c0, c1, c2] = candles;
  if (c2.low > c0.high) {
    return { direction: "bullish", zone_low: c0.high, zone_high: c2.low, midpoint: (c0.high + c2.low) / 2, formed_at: c2.time, candle_time: c1.time };
  }
  if (c2.high < c0.low) {
    return { direction: "bearish", zone_low: c2.high, zone_high: c0.low, midpoint: (c2.high + c0.low) / 2, formed_at: c2.time, candle_time: c1.time };
  }
  return null;
}
function checkFVGMitigation(fvg, candle, rule) {
  if (rule === "50_percent") {
    if (fvg.direction === "bullish" && candle.low <= fvg.midpoint) return true;
    if (fvg.direction === "bearish" && candle.high >= fvg.midpoint) return true;
  }
  if (rule === "body_close") {
    const bodyLow = Math.min(candle.open, candle.close);
    const bodyHigh = Math.max(candle.open, candle.close);
    if (bodyLow >= fvg.zone_low && bodyHigh <= fvg.zone_high) return true;
  }
  return false;
}
async function processFVGs(db, symbol, timeframe, candles, latestCandle) {
  const now = Date.now();
  const TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  const fvg = detectFVG(candles);
  if (fvg) {
    const tol = fvg.zone_low * 1e-3;
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
        crypto.randomUUID(),
        symbol,
        timeframe,
        fvg.direction,
        fvg.zone_low,
        fvg.zone_high,
        fvg.midpoint,
        fvg.formed_at,
        fvg.candle_time,
        fvg.formed_at + TTL_MS,
        now
      ).run();
    }
  }
  const { results: activeFVGs } = await db.prepare(
    `SELECT * FROM detected_fvgs WHERE symbol=? AND timeframe=? AND mitigated=0 AND expires_at>?`
  ).bind(symbol, timeframe, now).all();
  for (const activeFVG of activeFVGs) {
    const rule = activeFVG.mitigation_rule || "50_percent";
    if (checkFVGMitigation(activeFVG, latestCandle, rule)) {
      await db.prepare(`UPDATE detected_fvgs SET mitigated=1, mitigated_at=? WHERE id=?`).bind(now, activeFVG.id).run();
    }
  }
}
function getCandleDirection(candle, priorDirection) {
  if (candle.close > candle.open) return "bullish";
  if (candle.close < candle.open) return "bearish";
  return priorDirection;
}
async function updateSwingState(db, symbol, timeframe, candles) {
  const currentCandle = candles[2];
  const now = Date.now();
  const state = await db.prepare(
    `SELECT * FROM swing_state WHERE symbol=? AND timeframe=?`
  ).bind(symbol, timeframe).first();
  if (!state) {
    const dir = currentCandle.close >= currentCandle.open ? "bullish" : "bearish";
    await db.prepare(
      `INSERT INTO swing_state
       (symbol,timeframe,run_direction,run_start,run_extreme,extreme_time,updated_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      symbol,
      timeframe,
      dir,
      currentCandle.time,
      dir === "bullish" ? currentCandle.high : currentCandle.low,
      currentCandle.time,
      now
    ).run();
    return null;
  }
  const currentDir = getCandleDirection(currentCandle, state.run_direction);
  let newState = { ...state };
  if (currentDir === state.run_direction) {
    if (currentDir === "bullish" && currentCandle.high > state.run_extreme) {
      newState.run_extreme = currentCandle.high;
      newState.extreme_time = currentCandle.time;
    } else if (currentDir === "bearish" && currentCandle.low < state.run_extreme) {
      newState.run_extreme = currentCandle.low;
      newState.extreme_time = currentCandle.time;
    }
  } else {
    if (state.run_direction === "bullish") {
      newState.confirmed_swing_high = state.run_extreme;
      newState.confirmed_swing_high_time = state.extreme_time;
    } else {
      newState.confirmed_swing_low = state.run_extreme;
      newState.confirmed_swing_low_time = state.extreme_time;
    }
    newState.run_direction = currentDir;
    newState.run_start = currentCandle.time;
    newState.run_extreme = currentDir === "bullish" ? currentCandle.high : currentCandle.low;
    newState.extreme_time = currentCandle.time;
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
    symbol,
    timeframe,
    newState.run_direction,
    newState.run_start,
    newState.run_extreme,
    newState.extreme_time,
    newState.confirmed_swing_high ?? null,
    newState.confirmed_swing_high_time ?? null,
    newState.confirmed_swing_low ?? null,
    newState.confirmed_swing_low_time ?? null,
    newState.updated_at
  ).run();
  return detectMSS(newState, currentCandle);
}
function detectMSS(swingState, currentCandle) {
  if (swingState.run_direction === "bearish" && swingState.confirmed_swing_high != null && currentCandle.close > swingState.confirmed_swing_high) {
    return { direction: "bullish", level: swingState.confirmed_swing_high, candle_time: currentCandle.time };
  }
  if (swingState.run_direction === "bullish" && swingState.confirmed_swing_low != null && currentCandle.close < swingState.confirmed_swing_low) {
    return { direction: "bearish", level: swingState.confirmed_swing_low, candle_time: currentCandle.time };
  }
  return null;
}
function formatMSSAlert(symbol, tf, mss, htfBias, htfLabelStr) {
  const emoji = mss.direction === "bullish" ? "\u{1F7E2}" : "\u{1F534}";
  const label = mss.direction === "bullish" ? "BULLISH MSS" : "BEARISH MSS";
  const swingLabel = mss.direction === "bullish" ? "Swing high reclaimed" : "Swing low reclaimed";
  const aligned = mss.direction === htfBias || htfBias === "neutral";
  return `${emoji} <b>${label} \u2014 ${symbol}</b>
\u23F1 Timeframe: ${tf}
\u{1F550} Candle: ${fmtNY(mss.candle_time)} NY
\u{1F4CA} Trend: ${htfBias} (${htfLabelStr}) ${aligned ? "\u2705" : "\u26A0\uFE0F"}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
${swingLabel}: ${mss.level?.toFixed(5)}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
<i>EBP Tracker</i>`;
}
async function generateEbpSignalId(tf, symbol, env) {
  const counterKey = `EBP-${tf}`;
  const row = await env.DB.prepare(
    "SELECT series, count FROM signal_counters WHERE template = ?"
  ).bind(counterKey).first();
  let { series, count } = row;
  count += 1;
  if (count > 999) {
    series = String.fromCharCode(series.charCodeAt(0) + 1);
    count = 1;
  }
  await env.DB.prepare(
    "UPDATE signal_counters SET series = ?, count = ? WHERE template = ?"
  ).bind(series, count, counterKey).run();
  const normSymbol = symbol.replace("/", "").toUpperCase();
  const countStr = count.toString().padStart(3, "0");
  return `EBP-${normSymbol}-${tf}${series}${countStr}`;
}
async function generateSignalId(db, template, symbol) {
  const row = await db.prepare(
    "SELECT series, count FROM signal_counters WHERE template = ?"
  ).bind(template).first();
  let { series, count } = row;
  count += 1;
  if (count > 999) {
    series = String.fromCharCode(series.charCodeAt(0) + 1);
    count = 1;
  }
  await db.prepare(
    "UPDATE signal_counters SET series = ?, count = ? WHERE template = ?"
  ).bind(series, count, template).run();
  const normSymbol = symbol.replace("/", "").toUpperCase();
  const countStr = count.toString().padStart(3, "0");
  return `${template}-${normSymbol}-${series}${countStr}`;
}
function getEbpExpiresAt(tf) {
  const now = /* @__PURE__ */ new Date();
  if (tf === "1W") {
    const month = now.getUTCMonth();
    const quarterEndMonth = Math.floor(month / 3) * 3 + 3;
    return new Date(Date.UTC(
      now.getUTCFullYear() + (quarterEndMonth === 12 ? 1 : 0),
      quarterEndMonth === 12 ? 0 : quarterEndMonth,
      1
    )).toISOString();
  }
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    1
  )).toISOString();
}
async function handleEBPCron(tf, env, debugLog = null) {
  const log = /* @__PURE__ */ __name((msg) => {
    console.log(msg);
    if (debugLog) debugLog.push(msg);
  }, "log");
  if (tf === "D") {
    await env.DB.prepare(`
      DELETE FROM signals
      WHERE template_type = 'EBP'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
    `).bind((/* @__PURE__ */ new Date()).toISOString()).run();
  }
  log(`EBP trigger \u2192 TF: ${tf}`);
  const { results: filtered } = await env.DB.prepare(`
    SELECT ec.id as config_id, ec.alert_mode, ec.htf_override,
           ua.id as asset_id, ua.symbol, ua.bias_overrides,
           u.id as user_id, u.user_tf_access
    FROM user_ebp_configs ec
    JOIN user_assets ua ON ec.asset_id = ua.id
    JOIN users u ON ec.user_id = u.id
    WHERE ec.timeframe=? AND ec.enabled=1
    AND u.active=1
  `).bind(tf).all();
  if (!filtered?.length) {
    log(`No enabled EBP configs for TF ${tf}`);
    return { symbolsProcessed: 0 };
  }
  const symbolMap = /* @__PURE__ */ new Map();
  for (const row of filtered) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, []);
    symbolMap.get(row.symbol).push(row);
  }
  log(`Processing ${symbolMap.size} symbol(s) on ${tf}`);
  const defaultBiasTF = BIAS_SOURCE.ebp[tf] ?? null;
  for (const [symbol, userRows] of symbolMap) {
    try {
      let candles;
      if (tf === "D") {
        candles = await getDailyCandlesFromCache(symbol, env);
        if (!candles || candles.length < 2) {
          log(`[${symbol}] SKIP: insufficient daily candles in cache`);
          continue;
        }
      } else if (tf === "W") {
        candles = await getWeeklyCandlesFromCache(symbol, env);
        if (!candles || candles.length < 2) {
          log(`[${symbol}] SKIP: insufficient weekly candles in cache`);
          continue;
        }
      } else {
        candles = await getCandlesFromCache(symbol, tf, env);
        if (!candles || candles.length < 2) {
          log(`[${symbol}] SKIP: insufficient candles in cache`);
          continue;
        }
      }
      const neededHtfs = new Set(userRows.map((row) => resolveHTF("ebp", tf, row.htf_override)).filter(Boolean));
      const biasByTF = /* @__PURE__ */ new Map();
      for (const htf of neededHtfs) {
        let htfCandles;
        if (htf === "D") {
          htfCandles = await getDailyCandlesFromCache(symbol, env);
        } else if (htf === "W") {
          htfCandles = await getWeeklyCandlesFromCache(symbol, env);
        } else {
          htfCandles = await getCandlesFromCache(symbol, htf, env);
        }
        let bias = "neutral";
        if (htfCandles?.length >= 2) {
          const biasResult = calcTTradesBias({ bar1: htfCandles[0], bar2: htfCandles[1] });
          biasResult.bar1Time = htfCandles[0].time;
          bias = biasResult.bias;
          await writeBiasCache(env.DB, symbol, htf, biasResult);
        }
        biasByTF.set(htf, bias);
      }
      const htfBias = defaultBiasTF ? biasByTF.get(defaultBiasTF) ?? "neutral" : "neutral";
      let mssResult = null;
      if (tf === "D") {
        mssResult = await updateSwingState(env.DB, symbol, tf, [null, null, candles[0]]);
      } else if (candles.length >= 3) {
        const oldestFirst = [candles[2], candles[1], candles[0]];
        await processFVGs(env.DB, symbol, tf, oldestFirst, candles[0]);
        mssResult = await updateSwingState(env.DB, symbol, tf, oldestFirst);
      }
      if (mssResult) {
        for (const row of userRows) {
          const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
          if (!userTfAccess.includes(tf)) continue;
          const userBiasTF = resolveHTF("ebp", tf, row.htf_override);
          const userHtfBias = userBiasTF ? biasByTF.get(userBiasTF) ?? "neutral" : "neutral";
          const alertMode = row.alert_mode ?? "aligned";
          const biasOverrides = JSON.parse(row.bias_overrides || "{}");
          const effectiveBias = getEffectiveBias(userBiasTF, { [userBiasTF]: { bias: userHtfBias } }, biasOverrides);
          const shouldAlert = alertMode === "all" || mssResult.direction === effectiveBias || effectiveBias === "neutral";
          if (!shouldAlert) continue;
          const tg = await env.DB.prepare(
            "SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1"
          ).bind(row.user_id).first();
          if (!tg?.chat_id) continue;
          const msg = formatMSSAlert(symbol, tf, mssResult, userHtfBias, getHTFBiasLabel(userBiasTF));
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);
          await env.DB.prepare(
            `INSERT INTO alert_history
             (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
             VALUES (?,?,?,?,?,?,?,?,'mss')`
          ).bind(
            crypto.randomUUID(),
            row.user_id,
            symbol,
            tf,
            mssResult.direction,
            userHtfBias,
            mssResult.candle_time,
            Date.now()
          ).run();
        }
      }
      const ebp = detectEBP(candles);
      if (!ebp) {
        log(`[${symbol}] no EBP detected`);
        continue;
      }
      let ebpSignalId = null;
      if (tf !== "W") {
        const signalTf = tf === "D" ? "1D" : tf;
        ebpSignalId = await generateEbpSignalId(signalTf, symbol, env);
        const firedAt = (/* @__PURE__ */ new Date()).toISOString();
        await env.DB.prepare(`
          INSERT INTO signals (
            signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at, expires_at,
            price_at_signal, htf_bias, session, htf_close
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          ebpSignalId,
          "EBP",
          symbol,
          null,
          signalTf,
          ebp.direction,
          firedAt,
          getEbpExpiresAt(signalTf),
          ebp.closedLevel ?? null,
          htfBias ?? null,
          deriveSession(firedAt),
          null
        ).run();
      }
      for (const row of userRows) {
        const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
        if (!userTfAccess.includes(tf)) continue;
        const userBiasTF = resolveHTF("ebp", tf, row.htf_override);
        const userHtfBias = userBiasTF ? biasByTF.get(userBiasTF) ?? "neutral" : "neutral";
        const alertMode = row.alert_mode ?? "aligned";
        const biasOverrides = JSON.parse(row.bias_overrides || "{}");
        const effectiveBias = getEffectiveBias(userBiasTF, { [userBiasTF]: { bias: userHtfBias } }, biasOverrides);
        const trendAligned = ebp.direction === effectiveBias;
        if (alertMode === "aligned" && !trendAligned) continue;
        const tg = await env.DB.prepare(
          "SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1"
        ).bind(row.user_id).first();
        if (!tg?.chat_id) continue;
        const msg = formatEBPAlert({
          symbol,
          tf,
          direction: ebp.direction,
          candleTime: ebp.candleTime,
          trendBias: effectiveBias,
          trendAligned,
          sweptLevel: ebp.sweptLevel?.toFixed(5),
          closedLevel: ebp.closedLevel?.toFixed(5),
          signalId: ebpSignalId,
          biasTF: userBiasTF
        });
        await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);
        await env.DB.prepare(`
          INSERT INTO alert_history
          (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
          VALUES (?,?,?,?,?,?,?,?,'ebp')
        `).bind(
          crypto.randomUUID(),
          row.user_id,
          symbol,
          tf,
          ebp.direction,
          effectiveBias,
          ebp.candleTime,
          Date.now()
        ).run();
        const tmpl = await env.DB.prepare(
          `SELECT * FROM user_templates WHERE user_id=? AND asset_id=? AND template='t3' AND enabled=1 AND htf=?`
        ).bind(row.user_id, row.asset_id, tf).first();
        if (tmpl) {
          const t3SignalId = await generateSignalId(env.DB, "T3", symbol);
          await initiateT3Chain(
            env.DB,
            row.user_id,
            row.asset_id,
            symbol,
            ebp.direction,
            tf,
            tmpl.ltf,
            tmpl.window_mins,
            t3SignalId
          );
          const t3FiredAt = (/* @__PURE__ */ new Date()).toISOString();
          const t3Msg = formatT3Alert(
            symbol,
            tf,
            tmpl.ltf,
            ebp.direction,
            deriveSession(t3FiredAt),
            ebp.closedLevel ?? null,
            t3SignalId,
            1
          );
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, t3Msg);
        }
      }
      await new Promise((r) => setTimeout(r, 1e3));
    } catch (err) {
      const msg = `Error ${symbol} ${tf}: ${err.message}`;
      console.error(msg);
      if (debugLog) debugLog.push(`[ERROR] ${msg}`);
    }
  }
  return { symbolsProcessed: symbolMap.size };
}
async function verifyClerkToken(token, secretKey) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const payload = JSON.parse(
    atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
  );
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1e3)) {
    throw new Error("Token expired");
  }
  const jwksRes = await fetch("https://api.clerk.com/v1/jwks", {
    headers: { Authorization: `Bearer ${secretKey}` }
  });
  const jwks = await jwksRes.json();
  const header = JSON.parse(
    atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"))
  );
  const jwk = jwks.keys?.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("JWK key not found");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const enc = new TextEncoder();
  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const sig = Uint8Array.from(
    atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  );
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  if (!valid) throw new Error("Invalid signature");
  return {
    id: payload.sub,
    email: payload.email ?? payload.primary_email_address ?? "",
    name: payload.first_name ? `${payload.first_name} ${payload.last_name ?? ""}`.trim() : ""
  };
}
async function getOrCreateUser(db, clerkUser) {
  const now = Date.now();
  const expires = now + 30 * 24 * 60 * 60 * 1e3;
  await db.prepare(`
    INSERT INTO users (id, email, name, created_at, expires_at, asset_limit, user_tf_access, nse_tf_access)
    VALUES (?,?,?,?,?,5,'["M5","M15","M30","1H","4H","D","W"]','["M1","M5","M15","M30","1H","D"]')
    ON CONFLICT(id) DO NOTHING
  `).bind(clerkUser.id, clerkUser.email, clerkUser.email.split("@")[0], now, expires).run();
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(clerkUser.id).first();
  if (user?.active && user.expires_at < now) {
    await db.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(clerkUser.id).run();
    user.active = 0;
  }
  return user;
}
var router = new Router();
router.get("/health", async (req, env) => {
  return json({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() }, 200, getOrigin(req));
});
router.get("/user/me", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  await getOrCreateUser(env.DB, clerkUser);
  const user = await env.DB.prepare(
    "SELECT id, email, name, plan, asset_limit, created_at, expires_at, active, is_admin, user_tf_access, nse_tf_access FROM users WHERE id=?"
  ).bind(clerkUser.id).first();
  return json(user, 200, origin);
});
router.get("/user/assets", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const assets = await env.DB.prepare(
    "SELECT * FROM user_assets WHERE user_id = ? ORDER BY added_at ASC"
  ).bind(clerkUser.id).all();
  const enriched = await Promise.all((assets.results ?? []).map(async (asset) => {
    const { results: configs } = await env.DB.prepare(
      "SELECT timeframe FROM user_ebp_configs WHERE asset_id = ? AND enabled = 1"
    ).bind(asset.id).all();
    const tfs = (configs ?? []).map((c) => c.timeframe);
    const status = {};
    for (const tf of tfs) {
      let candles;
      if (tf === "D") candles = await getDailyCandlesFromCache(asset.symbol, env);
      else if (tf === "W") candles = await getWeeklyCandlesFromCache(asset.symbol, env);
      else candles = await getCandlesFromCache(asset.symbol, tf, env);
      if (candles && candles.length >= 2) {
        const ebp = detectEBP(candles);
        status[tf] = ebp ? ebp.direction : "none";
      } else {
        status[tf] = "none";
      }
    }
    return { ...asset, ebpStatus: status };
  }));
  return json(enriched, 200, origin);
});
router.post("/user/assets", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const body = await req.json();
  const user = await getOrCreateUser(env.DB, clerkUser);
  const assetType = body.assetType ?? "forex";
  if (assetType !== "nse") {
    const count = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND asset_type != 'nse'"
    ).bind(clerkUser.id).first();
    if (count.cnt >= user.asset_limit) {
      return json({ error: "asset_limit_reached", limit: user.asset_limit }, 403, origin);
    }
  }
  const symbolStr = normaliseSymbol(String(body.symbol ?? "").toUpperCase().trim());
  if (!symbolStr) {
    return json({ error: "Symbol is required." }, 400, origin);
  }
  const existing = await env.DB.prepare(
    "SELECT id FROM user_assets WHERE user_id = ? AND symbol = ?"
  ).bind(clerkUser.id, symbolStr).first();
  if (existing) {
    return json({ error: "Asset already in your list." }, 400, origin);
  }
  if (assetType !== "forex" && assetType !== "crypto") {
    const validation = await validateSymbol(symbolStr, env.TWELVE_DATA_API_KEY);
    if (!validation.valid) {
      return json({ error: "Symbol not found on any data source." }, 400, origin);
    }
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO user_assets (id, user_id, symbol, display_name, asset_type, added_at)
    VALUES (?,?,?,?,?,?)
  `).bind(
    id,
    clerkUser.id,
    symbolStr,
    body.displayName ?? symbolStr,
    assetType,
    Date.now()
  ).run();
  return json({ id, symbol: symbolStr }, 201, origin);
});
router.get("/user/assets/count", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const forexRow = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND asset_type != 'nse'"
  ).bind(clerkUser.id).first();
  const nseRow = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND asset_type = 'nse'"
  ).bind(clerkUser.id).first();
  const userRow = await env.DB.prepare(
    "SELECT asset_limit FROM users WHERE id = ?"
  ).bind(clerkUser.id).first();
  const forexCryptoCount = forexRow?.cnt ?? 0;
  const nseCount = nseRow?.cnt ?? 0;
  const limit = userRow?.asset_limit ?? 5;
  return json({
    forex_crypto_count: forexCryptoCount,
    forex_crypto_limit: limit,
    forex_crypto_remaining: Math.max(0, limit - forexCryptoCount),
    nse_count: nseCount,
    nse_limit: "unlimited"
  }, 200, origin);
});
router.delete("/user/assets/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  await env.DB.prepare("DELETE FROM user_ebp_configs WHERE asset_id = ?").bind(params.id).run();
  await env.DB.prepare("DELETE FROM user_sweep_configs WHERE asset_id = ?").bind(params.id).run();
  await env.DB.prepare("DELETE FROM user_templates WHERE asset_id = ?").bind(params.id).run();
  await env.DB.prepare("DELETE FROM chain_state WHERE asset_id = ?").bind(params.id).run();
  await env.DB.prepare(
    "DELETE FROM user_assets WHERE id = ? AND user_id = ?"
  ).bind(params.id, clerkUser.id).run();
  return json({ success: true }, 200, origin);
});
router.patch("/user/assets/:id/bias-overrides", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { bias_overrides } = await req.json();
  await env.DB.prepare(
    "UPDATE user_assets SET bias_overrides = ? WHERE id = ? AND user_id = ?"
  ).bind(JSON.stringify(bias_overrides ?? {}), params.id, clerkUser.id).run();
  return json({ ok: true }, 200, origin);
});
router.get("/user/assets/validate", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const url = new URL(req.url);
  const rawSymbol = url.searchParams.get("symbol");
  if (!rawSymbol) return json({ valid: false, error: "Symbol is required" }, 400, origin);
  const symbol = normaliseSymbol(rawSymbol.trim().toUpperCase());
  if (["NIFTY", "SENSEX", "SPX", "DJI", "NDX"].includes(symbol)) {
    return json({ valid: true, symbol, asset_type: "index" }, 200, origin);
  }
  return json({ valid: true, symbol, asset_type: guessAssetType(symbol), source: "fallback" }, 200, origin);
});
router.get("/user/ebp-configs/:assetId", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { results } = await env.DB.prepare(
    "SELECT * FROM user_ebp_configs WHERE asset_id=? AND user_id=? ORDER BY created_at ASC"
  ).bind(params.assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
});
router.post("/user/ebp-configs/:assetId", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { timeframe, alert_mode } = await req.json();
  if (!timeframe) return json({ error: "timeframe required" }, 400, origin);
  const asset = await env.DB.prepare("SELECT asset_type FROM user_assets WHERE id = ?").bind(params.assetId).first();
  let tfAccess;
  if (asset?.asset_type === "nse") {
    const userRow = await env.DB.prepare("SELECT nse_tf_access FROM users WHERE id = ?").bind(clerkUser.id).first();
    tfAccess = JSON.parse(userRow?.nse_tf_access || '["M1","M5","M15","M30","1H","D"]');
  } else {
    const userRow = await env.DB.prepare("SELECT user_tf_access FROM users WHERE id = ?").bind(clerkUser.id).first();
    tfAccess = JSON.parse(userRow?.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
  }
  if (!tfAccess.includes(timeframe)) {
    return json({ error: "tf_access_denied", message: "This timeframe is not enabled for your account" }, 403, origin);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO user_ebp_configs (id,user_id,asset_id,timeframe,alert_mode,enabled,created_at) VALUES (?,?,?,?,?,1,?)"
  ).bind(id, clerkUser.id, params.assetId, timeframe, alert_mode ?? "aligned", Date.now()).run();
  return json({ id, timeframe, alert_mode: alert_mode ?? "aligned", enabled: 1 }, 201, origin);
});
router.get("/user/sweep-configs/:assetId", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { results } = await env.DB.prepare(
    "SELECT * FROM user_sweep_configs WHERE asset_id=? AND user_id=? ORDER BY created_at ASC"
  ).bind(params.assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
});
router.post("/user/sweep-configs/:assetId", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { timeframe, alert_mode } = await req.json();
  if (!timeframe) return json({ error: "timeframe required" }, 400, origin);
  const asset = await env.DB.prepare("SELECT asset_type FROM user_assets WHERE id = ?").bind(params.assetId).first();
  let tfAccess;
  if (asset?.asset_type === "nse") {
    const userRow = await env.DB.prepare("SELECT nse_tf_access FROM users WHERE id = ?").bind(clerkUser.id).first();
    tfAccess = JSON.parse(userRow?.nse_tf_access || '["M1","M5","M15","M30","1H","D"]');
  } else {
    const userRow = await env.DB.prepare("SELECT user_tf_access FROM users WHERE id = ?").bind(clerkUser.id).first();
    tfAccess = JSON.parse(userRow?.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
  }
  if (!tfAccess.includes(timeframe)) {
    return json({ error: "tf_access_denied", message: "This timeframe is not enabled for your account" }, 403, origin);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO user_sweep_configs (id,user_id,asset_id,timeframe,alert_mode,enabled,created_at) VALUES (?,?,?,?,?,1,?)"
  ).bind(id, clerkUser.id, params.assetId, timeframe, alert_mode ?? "aligned", Date.now()).run();
  return json({ id, timeframe, alert_mode: alert_mode ?? "aligned", enabled: 1 }, 201, origin);
});
router.get("/user/templates/:assetId", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { results } = await env.DB.prepare(
    "SELECT * FROM user_templates WHERE asset_id=? AND user_id=? ORDER BY created_at ASC"
  ).bind(params.assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
});
router.post("/user/templates/:assetId", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { template, htf, ltf, window_mins, enabled } = await req.json();
  if (!template || !htf || !ltf) return json({ error: "template, htf, ltf required" }, 400, origin);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO user_templates (id,user_id,asset_id,template,enabled,htf,ltf,window_mins,created_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(id, clerkUser.id, params.assetId, template, enabled ? 1 : 0, htf, ltf, window_mins ?? 60, Date.now()).run();
  return json({ id, template, htf, ltf, window_mins: window_mins ?? 60, enabled: enabled ? 1 : 0 }, 201, origin);
});
var TEMPLATE_TF_RANK = { "M5": 1, "M15": 2, "M30": 3, "1H": 4, "4H": 5, "D": 6, "W": 7 };
router.patch("/user/template/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { enabled, htf, ltf, window_mins } = await req.json();
  if (htf && ltf && TEMPLATE_TF_RANK[ltf] >= TEMPLATE_TF_RANK[htf]) {
    return json({ error: "LTF must be strictly lower than HTF" }, 400, origin);
  }
  await env.DB.prepare(
    "UPDATE user_templates SET enabled=COALESCE(?,enabled), htf=COALESCE(?,htf), ltf=COALESCE(?,ltf), window_mins=COALESCE(?,window_mins) WHERE id=? AND user_id=?"
  ).bind(enabled ?? null, htf ?? null, ltf ?? null, window_mins ?? null, params.id, clerkUser.id).run();
  return json({ ok: true }, 200, origin);
});
router.delete("/user/template/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  await env.DB.prepare(
    "DELETE FROM user_templates WHERE id=? AND user_id=?"
  ).bind(params.id, clerkUser.id).run();
  return json({ ok: true }, 200, origin);
});
router.get("/dashboard", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const assets = await env.DB.prepare(`
    SELECT ua.*,
      (SELECT fired_at FROM alert_history
       WHERE user_id = ua.user_id AND symbol = ua.symbol
       ORDER BY fired_at DESC LIMIT 1) as last_alert_at
    FROM user_assets ua
    WHERE ua.user_id = ?
    ORDER BY ua.added_at ASC
  `).bind(clerkUser.id).all();
  return json(assets.results ?? [], 200, origin);
});
router.patch("/user/ebp-configs/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const body = await req.json();
  let effectiveTf = body.timeframe;
  if (effectiveTf === void 0 && body.htf_override !== void 0) {
    const existing = await env.DB.prepare(
      "SELECT timeframe FROM user_ebp_configs WHERE id = ? AND user_id = ?"
    ).bind(params.id, clerkUser.id).first();
    effectiveTf = existing?.timeframe;
  }
  const sets = [];
  const vals = [];
  if (body.timeframe !== void 0) {
    sets.push("timeframe = ?");
    vals.push(body.timeframe);
    if (body.htf_override === void 0) {
      sets.push("htf_override = ?");
      vals.push(null);
    }
  }
  if (body.alert_mode !== void 0) {
    sets.push("alert_mode = ?");
    vals.push(body.alert_mode);
  }
  if (body.enabled !== void 0) {
    sets.push("enabled = ?");
    vals.push(body.enabled ? 1 : 0);
  }
  if (body.htf_override !== void 0) {
    if (body.htf_override === null) {
      sets.push("htf_override = ?");
      vals.push(null);
    } else {
      const allowed = VALID_HTF_OVERRIDES[effectiveTf];
      if (!allowed || !allowed.includes(body.htf_override)) {
        return json({ error: `htf_override not valid for timeframe ${effectiveTf}` }, 400, origin);
      }
      sets.push("htf_override = ?");
      vals.push(body.htf_override);
    }
  }
  if (!sets.length) return json({ ok: true }, 200, origin);
  vals.push(clerkUser.id, params.id);
  await env.DB.prepare(`UPDATE user_ebp_configs SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`).bind(...vals).run();
  return json({ ok: true }, 200, origin);
});
router.delete("/user/ebp-configs/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  await env.DB.prepare("DELETE FROM user_ebp_configs WHERE user_id = ? AND id = ?").bind(clerkUser.id, params.id).run();
  return json({ ok: true }, 200, origin);
});
router.patch("/user/sweep-configs/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const body = await req.json();
  let effectiveTf = body.timeframe;
  if (effectiveTf === void 0 && body.htf_override !== void 0) {
    const existing = await env.DB.prepare(
      "SELECT timeframe FROM user_sweep_configs WHERE id = ? AND user_id = ?"
    ).bind(params.id, clerkUser.id).first();
    effectiveTf = existing?.timeframe;
  }
  const sets = [];
  const vals = [];
  if (body.timeframe !== void 0) {
    sets.push("timeframe = ?");
    vals.push(body.timeframe);
    if (body.htf_override === void 0) {
      sets.push("htf_override = ?");
      vals.push(null);
    }
  }
  if (body.alert_mode !== void 0) {
    sets.push("alert_mode = ?");
    vals.push(body.alert_mode);
  }
  if (body.enabled !== void 0) {
    sets.push("enabled = ?");
    vals.push(body.enabled ? 1 : 0);
  }
  if (body.htf_override !== void 0) {
    if (body.htf_override === null) {
      sets.push("htf_override = ?");
      vals.push(null);
    } else {
      const allowed = VALID_HTF_OVERRIDES[effectiveTf];
      if (!allowed || !allowed.includes(body.htf_override)) {
        return json({ error: `htf_override not valid for timeframe ${effectiveTf}` }, 400, origin);
      }
      sets.push("htf_override = ?");
      vals.push(body.htf_override);
    }
  }
  if (!sets.length) return json({ ok: true }, 200, origin);
  vals.push(clerkUser.id, params.id);
  await env.DB.prepare(`UPDATE user_sweep_configs SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`).bind(...vals).run();
  return json({ ok: true }, 200, origin);
});
router.delete("/user/sweep-configs/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  await env.DB.prepare("DELETE FROM user_sweep_configs WHERE user_id = ? AND id = ?").bind(clerkUser.id, params.id).run();
  return json({ ok: true }, 200, origin);
});
router.get("/user/nse-indicator-configs/:assetId", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { results } = await env.DB.prepare(
    "SELECT * FROM nse_indicator_configs WHERE asset_id=? AND user_id=? ORDER BY created_at ASC"
  ).bind(params.assetId, clerkUser.id).all();
  return json(results ?? [], 200, origin);
});
router.post("/user/nse-indicator-configs/:assetId", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const { indicator, timeframe, stack_mode, day_filter, bias_mode, htf_timeframe } = await req.json();
  if (indicator !== "tdi" && indicator !== "sma") {
    return json({ error: "indicator must be 'tdi' or 'sma'" }, 400, origin);
  }
  const validTfs = indicator === "tdi" ? ["M15", "M30"] : ["M15", "M5"];
  if (!validTfs.includes(timeframe)) {
    return json({ error: `timeframe must be one of: ${validTfs.join(", ")}` }, 400, origin);
  }
  if (indicator === "sma" && bias_mode !== void 0 && !["ttrades", "htf_sma"].includes(bias_mode)) {
    return json({ error: "bias_mode must be 'ttrades' or 'htf_sma'" }, 400, origin);
  }
  if (indicator === "sma" && htf_timeframe !== void 0 && !["M30", "1H"].includes(htf_timeframe)) {
    return json({ error: "htf_timeframe must be 'M30' or '1H'" }, 400, origin);
  }
  const existing = await env.DB.prepare(
    "SELECT id FROM nse_indicator_configs WHERE user_id=? AND asset_id=? AND indicator=? AND timeframe=?"
  ).bind(clerkUser.id, params.assetId, indicator, timeframe).first();
  if (existing) {
    return json({ error: "Config already exists for this indicator/timeframe on this asset." }, 400, origin);
  }
  const finalStackMode = indicator === "sma" ? stack_mode === "loose" ? "loose" : "strict" : null;
  const finalDayFilter = indicator === "sma" ? day_filter === 0 ? 0 : 1 : null;
  const finalBiasMode = indicator === "sma" ? bias_mode === "htf_sma" ? "htf_sma" : "ttrades" : null;
  const finalHtfTimeframe = indicator === "sma" ? htf_timeframe === "M30" ? "M30" : "1H" : null;
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO nse_indicator_configs (id, user_id, asset_id, indicator, timeframe, stack_mode, day_filter, enabled, created_at, bias_mode, htf_timeframe)
    VALUES (?,?,?,?,?,?,?,1,?,?,?)
  `).bind(id, clerkUser.id, params.assetId, indicator, timeframe, finalStackMode, finalDayFilter, Date.now(), finalBiasMode, finalHtfTimeframe).run();
  return json({
    id,
    indicator,
    timeframe,
    stack_mode: finalStackMode,
    day_filter: finalDayFilter,
    bias_mode: finalBiasMode,
    htf_timeframe: finalHtfTimeframe,
    enabled: 1
  }, 201, origin);
});
router.patch("/user/nse-indicator-configs/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const body = await req.json();
  if (body.bias_mode !== void 0 && !["ttrades", "htf_sma"].includes(body.bias_mode)) {
    return json({ error: "bias_mode must be 'ttrades' or 'htf_sma'" }, 400, origin);
  }
  if (body.htf_timeframe !== void 0 && !["M30", "1H"].includes(body.htf_timeframe)) {
    return json({ error: "htf_timeframe must be 'M30' or '1H'" }, 400, origin);
  }
  const sets = [];
  const vals = [];
  if (body.enabled !== void 0) {
    sets.push("enabled = ?");
    vals.push(body.enabled ? 1 : 0);
  }
  if (body.stack_mode !== void 0) {
    sets.push("stack_mode = ?");
    vals.push(body.stack_mode === "loose" ? "loose" : "strict");
  }
  if (body.day_filter !== void 0) {
    sets.push("day_filter = ?");
    vals.push(body.day_filter ? 1 : 0);
  }
  if (body.bias_mode !== void 0) {
    sets.push("bias_mode = ?");
    vals.push(body.bias_mode);
  }
  if (body.htf_timeframe !== void 0) {
    sets.push("htf_timeframe = ?");
    vals.push(body.htf_timeframe);
  }
  if (!sets.length) return json({ ok: true }, 200, origin);
  vals.push(clerkUser.id, params.id);
  await env.DB.prepare(`UPDATE nse_indicator_configs SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`).bind(...vals).run();
  return json({ ok: true }, 200, origin);
});
router.delete("/user/nse-indicator-configs/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const config = await env.DB.prepare(
    "SELECT * FROM nse_indicator_configs WHERE id = ? AND user_id = ?"
  ).bind(params.id, clerkUser.id).first();
  await env.DB.prepare("DELETE FROM nse_indicator_configs WHERE id = ? AND user_id = ?").bind(params.id, clerkUser.id).run();
  if (config) {
    if (config.indicator === "tdi") {
      await env.DB.prepare(
        "DELETE FROM nse_indicator_chain WHERE user_id = ? AND asset_id = ? AND timeframe = ?"
      ).bind(clerkUser.id, config.asset_id, config.timeframe).run();
    } else if (config.indicator === "sma") {
      const asset = await env.DB.prepare("SELECT symbol FROM user_assets WHERE id = ?").bind(config.asset_id).first();
      if (asset?.symbol) {
        const stillUsed = await env.DB.prepare(`
          SELECT COUNT(*) as cnt FROM nse_indicator_configs ic
          JOIN user_assets ua ON ic.asset_id = ua.id
          WHERE ua.symbol = ? AND ic.timeframe = ? AND ic.indicator = 'sma'
        `).bind(asset.symbol, config.timeframe).first();
        if ((stillUsed?.cnt ?? 0) === 0) {
          await env.DB.prepare(
            "DELETE FROM nse_sma_state WHERE symbol = ? AND timeframe = ?"
          ).bind(asset.symbol, config.timeframe).run();
        }
      }
    }
  }
  return json({ ok: true }, 200, origin);
});
router.get("/user/bias/:symbol", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const symbol = decodeURIComponent(params.symbol);
  const { results } = await env.DB.prepare(
    "SELECT timeframe, bias, updated_at FROM bias_cache WHERE symbol = ?"
  ).bind(symbol).all();
  const out = {};
  for (const row of results ?? []) out[row.timeframe] = { bias: row.bias, updated_at: row.updated_at };
  return json(out, 200, origin);
});
router.get("/health/datasources", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const dayStart = Date.now() - 24 * 60 * 60 * 1e3;
  const { results } = await env.DB.prepare(
    `SELECT source, MAX(called_at) as lastCall, SUM(CASE WHEN called_at > ? THEN 1 ELSE 0 END) as callsToday,
     MAX(CASE WHEN called_at > ? THEN success ELSE 0 END) as lastSuccess
     FROM api_call_log GROUP BY source`
  ).bind(dayStart, dayStart).all();
  const { results: tdKeys } = await env.DB.prepare(
    `SELECT id FROM api_keys WHERE source='twelvedata' AND enabled=1`
  ).all();
  const keyIds = (tdKeys ?? []).map((k) => k.id);
  const sources = { yahoo: { lastCall: null, callsToday: 0, lastSuccess: false } };
  for (const id of keyIds) sources[id] = { lastCall: null, callsToday: 0, lastSuccess: false };
  for (const r of results ?? []) {
    sources[r.source] = { lastCall: r.lastCall, callsToday: r.callsToday, lastSuccess: r.lastSuccess === 1 };
  }
  const twelvedataToday = keyIds.reduce((sum, id) => sum + (sources[id]?.callsToday ?? 0), 0);
  return json({ sources, twelvedataToday, twelvedataLimit: 800 * (keyIds.length || 1) }, 200, origin);
});
router.get("/alerts/history", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "all";
  const limit = parseInt(url.searchParams.get("limit") ?? "100");
  const days = parseInt(url.searchParams.get("days") ?? "30");
  const assetId = url.searchParams.get("assetId");
  const since = Date.now() - days * 24 * 60 * 60 * 1e3;
  let query = "SELECT * FROM alert_history WHERE user_id = ? AND fired_at > ?";
  const params = [clerkUser.id, since];
  if (type !== "all") {
    query += " AND alert_type = ?";
    params.push(type);
  }
  if (assetId) {
    const asset = await env.DB.prepare("SELECT symbol FROM user_assets WHERE id = ? AND user_id = ?").bind(assetId, clerkUser.id).first();
    if (asset) {
      query += " AND symbol = ?";
      params.push(asset.symbol);
    }
  }
  query += " ORDER BY fired_at DESC LIMIT ?";
  params.push(limit);
  const alerts = await env.DB.prepare(query).bind(...params).all();
  return json(alerts.results ?? [], 200, origin);
});
router.get("/alerts/export", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const url = new URL(req.url);
  const days = url.searchParams.get("days");
  const from = days ? Date.now() - parseInt(days) * 24 * 60 * 60 * 1e3 : parseInt(url.searchParams.get("from") ?? "0");
  const to = parseInt(url.searchParams.get("to") ?? String(Date.now()));
  const assetId = url.searchParams.get("assetId");
  let query = "SELECT * FROM alert_history WHERE user_id = ? AND fired_at >= ? AND fired_at <= ?";
  const params = [clerkUser.id, from, to];
  if (assetId) {
    const asset = await env.DB.prepare("SELECT symbol FROM user_assets WHERE id = ? AND user_id = ?").bind(assetId, clerkUser.id).first();
    if (asset) {
      query += " AND symbol = ?";
      params.push(asset.symbol);
    }
  }
  query += " ORDER BY fired_at DESC LIMIT 5000";
  const alerts = await env.DB.prepare(query).bind(...params).all();
  return json(alerts.results ?? [], 200, origin);
});
router.get("/user/telegram", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const tg = await env.DB.prepare(
    "SELECT verified, chat_id FROM user_telegram WHERE user_id = ?"
  ).bind(clerkUser.id).first();
  if (!tg) return json({ connected: false }, 200, origin);
  return json({
    connected: tg.verified === 1,
    chatIdMasked: tg.chat_id ? `\u2022\u2022\u2022\u2022${String(tg.chat_id).slice(-4)}` : null
  }, 200, origin);
});
router.post("/user/telegram/initlink", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const code = Math.floor(1e3 + Math.random() * 9e3).toString();
  await env.DB.prepare(`
    INSERT INTO user_telegram (user_id, chat_id, link_code, verified, updated_at)
    VALUES (?,''  ,?,0,?)
    ON CONFLICT(user_id) DO UPDATE SET link_code = ?, updated_at = ?
  `).bind(clerkUser.id, code, Date.now(), code, Date.now()).run();
  return json({ code }, 200, origin);
});
router.post("/user/telegram/test", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const tg = await env.DB.prepare(
    "SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1"
  ).bind(clerkUser.id).first();
  if (!tg) return json({ error: "Telegram not connected" }, 400, origin);
  await sendTelegramMessage(
    env.SHARED_BOT_TOKEN,
    tg.chat_id,
    "\u{1F514} <b>Test alert from EBP Tracker</b>\n\nYour Telegram is connected and working correctly."
  );
  return json({ success: true }, 200, origin);
});
var BREADTH_CURRENCIES = ["EUR", "GBP", "USD", "JPY", "CHF", "CAD", "AUD", "NZD"];
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
function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const meanA = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const meanB = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA, dB = b[i] - meanB;
    num += dA * dB;
    da += dA * dA;
    db += dB * dB;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}
async function handleMarketBreadthCron(env, debugLog = []) {
  const BREADTH_TF = "1H";
  const now = Date.now();
  const pairData = {};
  for (const [pair, base, quote] of MAJOR_PAIRS) {
    const candles = await getCandlesFromCache(pair, BREADTH_TF, env);
    if (candles && candles.length >= 1) {
      pairData[pair] = { candles, base, quote };
    } else {
      debugLog.push(`skip ${pair}: no candles`);
    }
  }
  const heatmap = {};
  for (const c of BREADTH_CURRENCIES) heatmap[c] = {};
  for (const [pair, { candles, base, quote }] of Object.entries(pairData)) {
    const c = candles[0];
    const pct = c.open !== 0 ? (c.close - c.open) / c.open * 100 : 0;
    heatmap[base][quote] = parseFloat(pct.toFixed(4));
    heatmap[quote][base] = parseFloat((-pct).toFixed(4));
  }
  const strength = {};
  for (const ccy of BREADTH_CURRENCIES) {
    const vals = Object.values(heatmap[ccy]).filter((v) => !isNaN(v));
    strength[ccy] = vals.length > 0 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)) : 0;
  }
  await env.DB.prepare(
    "INSERT OR REPLACE INTO market_breadth_cache (tf, computed_at, heatmap, strength) VALUES (?,?,?,?)"
  ).bind(BREADTH_TF, now, JSON.stringify(heatmap), JSON.stringify(strength)).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO market_breadth_intraday (tf, snapshot_at, strength) VALUES (?,?,?)"
  ).bind(BREADTH_TF, now, JSON.stringify(strength)).run();
  await env.DB.prepare(
    "DELETE FROM market_breadth_intraday WHERE tf = ? AND snapshot_at < ?"
  ).bind(BREADTH_TF, now - 48 * 60 * 60 * 1e3).run();
  const seriesLen = Math.min(10, ...Object.values(pairData).map((d) => d.candles.length));
  const returnSeries = {};
  for (const ccy of BREADTH_CURRENCIES) returnSeries[ccy] = [];
  for (let i = 0; i < seriesLen; i++) {
    const snap = {};
    for (const ccy of BREADTH_CURRENCIES) snap[ccy] = {};
    for (const [pair, { candles, base, quote }] of Object.entries(pairData)) {
      if (i >= candles.length) continue;
      const c = candles[i];
      const pct = c.open !== 0 ? (c.close - c.open) / c.open * 100 : 0;
      snap[base][quote] = pct;
      snap[quote][base] = -pct;
    }
    for (const ccy of BREADTH_CURRENCIES) {
      const vals = Object.values(snap[ccy]).filter((v) => !isNaN(v));
      returnSeries[ccy].push(vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
    }
  }
  const matrix = {};
  for (const a of BREADTH_CURRENCIES) {
    matrix[a] = {};
    for (const b of BREADTH_CURRENCIES) {
      matrix[a][b] = a === b ? 1 : parseFloat(pearsonCorr(returnSeries[a], returnSeries[b]).toFixed(3));
    }
  }
  await env.DB.prepare(
    "INSERT OR REPLACE INTO market_breadth_correlation (tf, computed_at, matrix) VALUES (?,?,?)"
  ).bind(BREADTH_TF, now, JSON.stringify(matrix)).run();
  debugLog.push(`breadth ok: ${Object.keys(pairData).length}/28 pairs`);
  return { pairs_fetched: Object.keys(pairData).length };
}
router.post("/cron/ebp", async (req, env) => {
  const origin = getOrigin(req);
  const secret = req.headers.get("X-Cron-Secret");
  if (!secret || secret !== env.CRON_SECRET) {
    return json({ error: "Forbidden" }, 403, origin);
  }
  let body = {};
  try {
    body = await req.json();
  } catch {
  }
  const { tf } = body;
  if (!tf) return json({ error: "tf required" }, 400, origin);
  try {
    const debugLog = [];
    let result;
    if (tf === "BREADTH") {
      result = await handleMarketBreadthCron(env, debugLog);
    } else {
      result = await handleEBPCron(tf, env, debugLog);
    }
    return json({ ok: true, tf, fired_at: (/* @__PURE__ */ new Date()).toISOString(), debug: debugLog, ...result }, 200, origin);
  } catch (err) {
    console.error(`EBP cron trigger error TF=${tf}:`, err.message);
    return json({ error: err.message }, 500, origin);
  }
});
router.get("/market/breadth", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const cache = await env.DB.prepare(
    "SELECT * FROM market_breadth_cache WHERE tf = ?"
  ).bind("1H").first();
  if (!cache) {
    return json({ error: 'No breadth data yet \u2014 trigger POST /cron/ebp with {"tf":"BREADTH"} first' }, 404, origin);
  }
  const corr = await env.DB.prepare(
    "SELECT matrix FROM market_breadth_correlation WHERE tf = ?"
  ).bind("1H").first();
  const cutoff = Date.now() - 48 * 60 * 60 * 1e3;
  const { results: intraday } = await env.DB.prepare(
    "SELECT snapshot_at, strength FROM market_breadth_intraday WHERE tf = ? AND snapshot_at >= ? ORDER BY snapshot_at ASC"
  ).bind("1H", cutoff).all();
  return json({
    currencies: BREADTH_CURRENCIES,
    heatmap: JSON.parse(cache.heatmap),
    strength: JSON.parse(cache.strength),
    computed_at: cache.computed_at,
    intraday: (intraday ?? []).map((r) => ({ t: r.snapshot_at, strength: JSON.parse(r.strength) })),
    correlation: corr ? JSON.parse(corr.matrix) : null
  }, 200, origin);
});
router.post("/telegram/webhook", async (req, env) => {
  const origin = getOrigin(req);
  try {
    const body = await req.json();
    const message = body?.message;
    if (!message) return json({ ok: true }, 200, origin);
    const chatId = message.chat?.id?.toString();
    const text = (message.text ?? "").trim();
    if (text === "/start" || text.startsWith("/start ")) {
      await sendTelegramMessage(
        env.SHARED_BOT_TOKEN,
        chatId,
        '\u{1F44B} <b>Welcome to EBP Tracker Bot!</b>\n\nTo connect your account:\n1. Go to your EBP Tracker dashboard\n2. Open Settings \u2192 Telegram\n3. Click "Get Connection Code"\n4. Send the 4-digit code here\n\nWaiting for your code...'
      );
      return json({ ok: true }, 200, origin);
    }
    if (/^\d{4}$/.test(text)) {
      const record = await env.DB.prepare(
        "SELECT user_id FROM user_telegram WHERE link_code = ?"
      ).bind(text).first();
      if (!record) {
        await sendTelegramMessage(
          env.SHARED_BOT_TOKEN,
          chatId,
          "\u274C Invalid or expired code. Please get a new code from Settings \u2192 Telegram on the dashboard."
        );
        return json({ ok: true }, 200, origin);
      }
      await env.DB.prepare(
        "UPDATE user_telegram SET chat_id = ?, verified = 1, link_code = NULL, updated_at = ? WHERE user_id = ?"
      ).bind(chatId, Date.now(), record.user_id).run();
      await sendTelegramMessage(
        env.SHARED_BOT_TOKEN,
        chatId,
        "\u2705 <b>EBP Tracker connected!</b>\n\nYou will now receive EBP alerts here.\n\nGo back to the dashboard to configure your assets and alert preferences."
      );
      return json({ ok: true }, 200, origin);
    }
    await sendTelegramMessage(
      env.SHARED_BOT_TOKEN,
      chatId,
      "\u{1F916} Send your 4-digit connection code to link your account.\n\nGet the code from Settings \u2192 Telegram on the EBP Tracker dashboard."
    );
    return json({ ok: true }, 200, origin);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return json({ ok: true }, 200, origin);
  }
});
router.post("/user/telegram/verify", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const tg = await env.DB.prepare(
    "SELECT verified, chat_id FROM user_telegram WHERE user_id = ?"
  ).bind(clerkUser.id).first();
  if (!tg) return json({ verified: false }, 200, origin);
  return json({
    verified: tg.verified === 1,
    chatIdMasked: tg.chat_id ? "\u2022\u2022\u2022\u2022" + String(tg.chat_id).slice(-4) : null
  }, 200, origin);
});
router.delete("/user/telegram", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  await env.DB.prepare(
    "UPDATE user_telegram SET verified = 0, chat_id = '', updated_at = ? WHERE user_id = ?"
  ).bind(Date.now(), clerkUser.id).run();
  return json({ success: true }, 200, origin);
});
async function requireAdmin(clerkUser, db) {
  const u = await db.prepare("SELECT is_admin FROM users WHERE id = ?").bind(clerkUser.id).first();
  return u?.is_admin === 1;
}
router.get("/admin/users", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const users = await env.DB.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM user_assets WHERE user_id = u.id) as asset_count,
      (SELECT COUNT(*) FROM alert_history WHERE user_id = u.id) as alert_count,
      (SELECT verified FROM user_telegram WHERE user_id = u.id) as telegram_verified
    FROM users u ORDER BY u.created_at DESC
  `).all();
  return json(users.results ?? [], 200, origin);
});
router.get("/admin/tokens", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const tokens = await env.DB.prepare(
    "SELECT * FROM invite_tokens ORDER BY created_at DESC"
  ).all();
  return json(tokens.results ?? [], 200, origin);
});
router.post("/admin/invite", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const token = crypto.randomUUID().split("-")[0].toUpperCase();
  await env.DB.prepare(
    "INSERT INTO invite_tokens (token, created_at) VALUES (?,?)"
  ).bind(token, Date.now()).run();
  const appUrl = env.APP_URL ?? "https://ebp-tracker.pages.dev";
  return json({ token, url: `${appUrl}/invite/${token}` }, 201, origin);
});
router.post("/admin/expire/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  await env.DB.prepare(
    "UPDATE users SET active = 0, expires_at = ? WHERE id = ?"
  ).bind(Date.now(), params.id).run();
  return json({ success: true }, 200, origin);
});
router.get("/admin/api-keys", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const { results } = await env.DB.prepare(`
    SELECT ak.id, ak.source, ak.label, ak.enabled, ak.added_at,
           COALESCE(aks.exhausted, 0) as exhausted,
           COALESCE(aks.calls_today, 0) as calls_today,
           '***' || substr(ak.key_value, -4) as key_preview
    FROM api_keys ak
    LEFT JOIN api_key_state aks ON ak.id = aks.key_name
    ORDER BY ak.source, ak.label ASC
  `).all();
  const DAILY_LIMIT = 800;
  const resetsAtUtc = new Date(Date.UTC(
    (/* @__PURE__ */ new Date()).getUTCFullYear(),
    (/* @__PURE__ */ new Date()).getUTCMonth(),
    (/* @__PURE__ */ new Date()).getUTCDate() + 1
  )).toISOString();
  const enriched = (results ?? []).map((k) => ({
    ...k,
    daily_limit: DAILY_LIMIT,
    credits_pct: Math.round(k.calls_today / DAILY_LIMIT * 100),
    resets_at_utc: resetsAtUtc
  }));
  return json(enriched, 200, origin);
});
router.post("/admin/api-keys", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const { source, key_value, label } = await req.json();
  if (!source || !key_value || !label) return json({ error: "source, key_value, label required" }, 400, origin);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO api_keys (id, source, key_value, label, enabled, added_at, added_by) VALUES (?,?,?,?,1,?,?)`
  ).bind(id, source, key_value, label, now, clerkUser.id).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO api_key_state (key_name, exhausted, calls_today, reset_at) VALUES (?,0,0,0)`
  ).bind(id).run();
  return json({ ok: true, id }, 201, origin);
});
router.patch("/admin/api-keys/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const { enabled } = await req.json();
  await env.DB.prepare(`UPDATE api_keys SET enabled=? WHERE id=?`).bind(enabled ? 1 : 0, params.id).run();
  return json({ ok: true }, 200, origin);
});
router.delete("/admin/api-keys/:id", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  await env.DB.prepare(`DELETE FROM api_keys WHERE id=?`).bind(params.id).run();
  await env.DB.prepare(`DELETE FROM api_key_state WHERE key_name=?`).bind(params.id).run();
  return json({ ok: true }, 200, origin);
});
router.patch("/admin/users/:id/asset-limit", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const { asset_limit } = await req.json();
  if (!asset_limit || asset_limit < 1 || asset_limit > 50) {
    return json({ error: "asset_limit must be between 1 and 50" }, 400, origin);
  }
  await env.DB.prepare(`UPDATE users SET asset_limit=? WHERE id=?`).bind(asset_limit, params.id).run();
  return json({ ok: true, asset_limit }, 200, origin);
});
router.get("/admin/users/:id/assets", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const assets = await env.DB.prepare(
    "SELECT symbol, asset_type, added_at FROM user_assets WHERE user_id = ? ORDER BY added_at ASC"
  ).bind(params.id).all();
  return json(assets.results ?? [], 200, origin);
});
var ALL_TF_ACCESS = ["M5", "M15", "M30", "1H", "4H", "D", "W"];
router.get("/admin/users/:id/tf-access", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const row = await env.DB.prepare("SELECT user_tf_access FROM users WHERE id=?").bind(params.id).first();
  if (!row) return json({ error: "User not found" }, 404, origin);
  const tfAccess = JSON.parse(row.user_tf_access || JSON.stringify(ALL_TF_ACCESS));
  return json({ user_id: params.id, tf_access: tfAccess }, 200, origin);
});
router.patch("/admin/users/:id/tf-access", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const { tf_access } = await req.json();
  if (!Array.isArray(tf_access) || tf_access.some((tf) => !ALL_TF_ACCESS.includes(tf))) {
    return json({ error: `tf_access must be an array containing only: ${ALL_TF_ACCESS.join(", ")}` }, 400, origin);
  }
  await env.DB.prepare(`UPDATE users SET user_tf_access=? WHERE id=?`).bind(JSON.stringify(tf_access), params.id).run();
  return json({ ok: true }, 200, origin);
});
var ALL_NSE_TF_ACCESS = ["M1", "M5", "M15", "M30", "1H", "D"];
router.get("/admin/users/:id/nse-tf-access", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const row = await env.DB.prepare("SELECT nse_tf_access FROM users WHERE id=?").bind(params.id).first();
  if (!row) return json({ error: "User not found" }, 404, origin);
  const nseTfAccess = JSON.parse(row.nse_tf_access || JSON.stringify(ALL_NSE_TF_ACCESS));
  return json({ user_id: params.id, nse_tf_access: nseTfAccess }, 200, origin);
});
router.patch("/admin/users/:id/nse-tf-access", async (req, env) => {
  const { user: clerkUser, origin, error, params } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  if (!await requireAdmin(clerkUser, env.DB)) return json({ error: "Access denied" }, 403, origin);
  const { nse_tf_access } = await req.json();
  if (!Array.isArray(nse_tf_access) || nse_tf_access.some((tf) => !ALL_NSE_TF_ACCESS.includes(tf))) {
    return json({ error: `nse_tf_access must be an array containing only: ${ALL_NSE_TF_ACCESS.join(", ")}` }, 400, origin);
  }
  await env.DB.prepare(`UPDATE users SET nse_tf_access=? WHERE id=?`).bind(JSON.stringify(nse_tf_access), params.id).run();
  return json({ ok: true }, 200, origin);
});
router.get("/nse/status", async (req, env) => {
  const { origin } = req._ctx;
  const key = await env.DB.prepare(
    "SELECT id FROM api_keys WHERE source='upstox' AND enabled=1 LIMIT 1"
  ).first();
  return json({ upstox_configured: !!key }, 200, origin);
});
var NSE_KNOWN_INDICES = ["^NSEI", "^NSEBANK", "^BSESN", "^NIFTYBANK"];
router.get("/nse/search", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return json([], 200, origin);
  try {
    const yahooRes = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&lang=en-IN&region=IN`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const data = await yahooRes.json();
    const quotes = data?.quotes ?? [];
    const results = quotes.filter(
      (item) => NSE_KNOWN_INDICES.includes(item.symbol) || /^[A-Z0-9&-]+\.NS$/.test(item.symbol ?? "") && item.quoteType === "EQUITY"
    ).map((item) => ({ symbol: item.symbol, shortName: item.shortname ?? item.longname ?? item.symbol }));
    return json(results, 200, origin);
  } catch (e) {
    return json({ error: "Search failed" }, 502, origin);
  }
});
router.get("/signals/:id", async (req, env) => {
  const { params } = req._ctx;
  const secret = req.headers.get("X-Journal-Secret");
  if (!secret || secret !== env.JOURNAL_API_SECRET) {
    return journalJson({ error: "Unauthorised" }, 401);
  }
  const row = await env.DB.prepare("SELECT * FROM signals WHERE signal_id = ?").bind(params.id).first();
  if (!row) return journalJson({ error: "Signal not found" }, 404);
  return journalJson(row, 200);
});
router.patch("/signals/:id/traded", async (req, env) => {
  const { params } = req._ctx;
  const secret = req.headers.get("X-Journal-Secret");
  if (!secret || secret !== env.JOURNAL_API_SECRET) {
    return journalJson({ error: "Unauthorised" }, 401);
  }
  const result = await env.DB.prepare("UPDATE signals SET traded = 1 WHERE signal_id = ?").bind(params.id).run();
  if (result.meta.changes === 0) return journalJson({ error: "Signal not found" }, 404);
  return journalJson({ ok: true }, 200);
});
router.get("/invite/:token", async (req, env) => {
  const { origin, params } = req._ctx;
  const record = await env.DB.prepare(
    "SELECT * FROM invite_tokens WHERE token = ? AND active = 1 AND used_by IS NULL"
  ).bind(params.token).first();
  if (!record) return json({ valid: false, error: "Invalid or already used token" }, 400, origin);
  return json({ valid: true, token: params.token }, 200, origin);
});
router.get("/sweep/dashboard", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const assets = await env.DB.prepare(`
    SELECT ua.id as asset_id, ua.symbol
    FROM user_assets ua
    WHERE ua.user_id = ?
  `).bind(clerkUser.id).all();
  const result = [];
  for (const asset of assets.results ?? []) {
    const { results: configs } = await env.DB.prepare(
      "SELECT timeframe FROM user_sweep_configs WHERE asset_id = ? AND enabled = 1"
    ).bind(asset.asset_id).all();
    const tfs = (configs ?? []).map((c) => c.timeframe);
    const status = {};
    for (const tf of tfs) {
      const candles = await getCandlesFromCache(asset.symbol, tf, env);
      status[tf] = candles && candles.length >= 2 ? detectSweep(candles)?.direction ?? "none" : "none";
    }
    result.push({ symbol: asset.symbol, sweepStatus: status });
  }
  return json(result, 200, origin);
});
router.get("/sweep/history", async (req, env) => {
  const { user: clerkUser, origin, error } = req._ctx;
  if (error || !clerkUser) return json({ error: error ?? "Unauthorized" }, 401, origin);
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "50");
  const alerts = await env.DB.prepare(`
    SELECT * FROM alert_history
    WHERE user_id = ? AND alert_type = 'sweep'
    ORDER BY fired_at DESC LIMIT ?
  `).bind(clerkUser.id, limit).all();
  return json(alerts.results ?? [], 200, origin);
});
var ebp_worker_default = {
  async fetch(request, env, ctx) {
    const origin = getOrigin(request);
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    if (method === "OPTIONS") {
      if (pathname.startsWith("/signals")) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Journal-Secret"
          }
        });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const match = router.match(method, pathname);
    if (!match) {
      return json({ error: "Not found", path: pathname }, 404, origin);
    }
    let clerkUser = null;
    let authError = null;
    const authHeader = request.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        clerkUser = await verifyClerkToken(
          authHeader.replace("Bearer ", ""),
          env.CLERK_SECRET_KEY
        );
      } catch (e) {
        authError = e.message;
      }
    }
    request._ctx = {
      user: clerkUser,
      error: authError,
      origin,
      params: match.params
    };
    try {
      return await match.handlers[0](request, env, ctx);
    } catch (err) {
      console.error("Handler error:", err);
      return json({ error: "Internal server error", detail: err.message }, 500, origin);
    }
  },
  // Cloudflare scheduled handler — not used (cron-job.org handles scheduling
  // via POST /cron/ebp; no [triggers] block in wrangler.toml calls this)
  async scheduled(event, env, ctx) {
    console.log("Scheduled event received \u2014 scheduling handled via cron-job.org HTTP triggers");
  }
};
export {
  ebp_worker_default as default
};

