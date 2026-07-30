var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/sweep-cron.js
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
  sweep: { "M15": "1H", "M30": "4H", "1H": "D", "4H": "W" },
  template: { "W": null, "D": "W", "4H": "D", "1H": "4H" }
};
function getHTFBiasLabel(biasTF) {
  const map = { "4H": "4H HTF bias", "D": "1D HTF bias", "W": "1W HTF bias", "1H": "1H HTF bias" };
  return map[biasTF] ?? `${biasTF} HTF bias`;
}
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
async function advanceT3Chain(db, chainId, ltfSweepTime) {
  await db.prepare(
    "UPDATE chain_state SET current_step=3, ltf_sweep_time=? WHERE id=?"
  ).bind(ltfSweepTime, chainId).run();
}
async function completeT3Chain(db, chainId) {
  await db.prepare("DELETE FROM chain_state WHERE id=?").bind(chainId).run();
}
async function getActiveChains(db, userId, symbol, template, direction, step) {
  const res = await db.prepare(`
    SELECT * FROM chain_state
    WHERE user_id=? AND symbol=? AND template=? AND direction=? AND current_step=? AND expires_at > ?
  `).bind(userId, symbol, template, direction, step, Date.now()).all();
  return res.results ?? [];
}
async function cleanupExpiredChains(db) {
  await db.prepare("DELETE FROM chain_state WHERE expires_at < ?").bind(Date.now()).run();
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
  if (!ts) return "\u2014";
  return new Date(Number(ts)).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
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
function formatSweepAlert({ symbol, tf, direction, candleTime, trendBias, trendAligned, sweptLevel, closedInsideLevel, trendMode, biasTF }) {
  const emoji = direction === "bullish" ? "\u{1F7E2}" : "\u{1F534}";
  const label = direction === "bullish" ? "BULLISH SWEEP" : "BEARISH SWEEP";
  const alignMark = trendAligned ? "\u2705" : trendMode === "price_action" ? "\u{1F4CA} Price Action" : "\u26A0\uFE0F No Trend Filter";
  const swept = direction === "bullish" ? "Low swept" : "High swept";
  return `${emoji} <b>${label} \u2014 ${symbol}</b>
\u23F1 Timeframe: ${tf}
\u{1F550} Candle: ${fmtNY(candleTime)} NY
\u{1F4CA} Trend: ${trendBias} (${getHTFBiasLabel(biasTF)}) ${alignMark}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
${swept}: ${sweptLevel}
Closed inside: ${closedInsideLevel}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
<i>EBP Tracker</i>`;
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
function getCandleDirection(candle, priorDirection) {
  if (candle.close > candle.open) return "bullish";
  if (candle.close < candle.open) return "bearish";
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
  } catch (e) {
    console.error(`[SWING] ERROR ${symbol} ${timeframe}: ${e.message}
${e.stack}`);
    return null;
  }
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
  try {
    console.log(`[FVG] Processing ${symbol} ${timeframe}`);
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
  } catch (e) {
    console.error(`[FVG] ERROR ${symbol} ${timeframe}: ${e.message}
${e.stack}`);
  }
}
async function cleanupExpiredFVGs(db) {
  const now = Date.now();
  await db.prepare(`UPDATE detected_fvgs SET mitigated=1, mitigated_at=? WHERE mitigated=0 AND expires_at<?`).bind(now, now).run();
}
async function handleSweepCron(tf, env, debugLog = null) {
  const log = /* @__PURE__ */ __name((msg) => {
    console.log(msg);
    if (debugLog) debugLog.push(msg);
  }, "log");
  log(`Sweep trigger \u2192 TF: ${tf}`);
  if (tf === "M15") {
    await cleanupExpiredFVGs(env.DB);
    await cleanupExpiredChains(env.DB);
    log("Cleaned up expired FVGs and chains");
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
  const symbolMap = /* @__PURE__ */ new Map();
  for (const row of filtered) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, []);
    symbolMap.get(row.symbol).push(row);
  }
  const defaultBiasTF = BIAS_SOURCE.sweep[tf] ?? null;
  for (const [symbol, userRows] of symbolMap) {
    try {
      const candles = await getCandlesFromCache(symbol, tf, env);
      log(`[${symbol}] candles fetched: ${candles?.length ?? "null"}`);
      if (!candles || candles.length < 2) {
        log(`[${symbol}] SKIP: insufficient candles in cache`);
        continue;
      }
      const neededHtfs = new Set(userRows.map((row) => resolveHTF("sweep", tf, row.htf_override)).filter(Boolean));
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
        log(`[${symbol}] htf(${htf}) candles fetched: ${htfCandles?.length ?? "null"}`);
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
      if (candles.length >= 3) {
        log(`[${symbol}] running FVG + swing (3 candles available)`);
        const oldestFirst = [candles[2], candles[1], candles[0]];
        await processFVGs(env.DB, symbol, tf, oldestFirst, candles[0]);
        const mssResult = await updateSwingState(env.DB, symbol, tf, oldestFirst);
        log(`[${symbol}] MSS result: ${mssResult ? mssResult.direction : "none"}`);
        if (mssResult) {
          for (const row of userRows) {
            const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
            if (!userTfAccess.includes(tf)) continue;
            const userBiasTF = resolveHTF("sweep", tf, row.htf_override);
            const userHtfBias = userBiasTF ? biasByTF.get(userBiasTF) ?? "neutral" : "neutral";
            const alertMode = row.alert_mode ?? "aligned";
            const biasOverrides = JSON.parse(row.bias_overrides || "{}");
            const effectiveBias = getEffectiveBias(userBiasTF, { [userBiasTF]: { bias: userHtfBias } }, biasOverrides);
            const shouldAlert = alertMode === "all" || alertMode === "price_action" || mssResult.direction === effectiveBias || effectiveBias === "neutral";
            if (!shouldAlert) continue;
            const tg = await env.DB.prepare(
              "SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1"
            ).bind(row.user_id).first();
            if (!tg?.chat_id) continue;
            const msg = formatMSSAlert(symbol, tf, mssResult, effectiveBias, getHTFBiasLabel(userBiasTF));
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
              effectiveBias,
              mssResult.candle_time,
              Date.now()
            ).run();
            const mssChains = await getActiveChains(env.DB, row.user_id, symbol, "t3", mssResult.direction, 3);
            for (const chain of mssChains) {
              if (chain.ltf !== tf) continue;
              const signalId = chain.htf_signal_id;
              const firedAt = (/* @__PURE__ */ new Date()).toISOString();
              await env.DB.prepare(`
                INSERT INTO signals (
                  signal_id, template_type, symbol, htf_tf, ltf_tf, direction, fired_at,
                  price_at_signal, htf_bias, session, htf_close
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                signalId,
                "T3",
                symbol,
                chain.htf_tf,
                tf,
                mssResult.direction,
                firedAt,
                candles[0].close ?? null,
                htfBias ?? null,
                deriveSession(firedAt),
                chain.htf_close ?? null
              ).run();
              const t3Msg = formatT3Alert(
                symbol,
                chain.htf_tf,
                tf,
                mssResult.direction,
                deriveSession(firedAt),
                candles[0].close ?? null,
                signalId,
                3
              );
              await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, t3Msg);
              await env.DB.prepare(`
                INSERT INTO alert_history
                (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
                VALUES (?,?,?,?,?,?,?,?,'t3')
              `).bind(
                crypto.randomUUID(),
                row.user_id,
                symbol,
                `${chain.htf_tf}+${tf}`,
                mssResult.direction,
                effectiveBias,
                mssResult.candle_time,
                Date.now()
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
        const userBiasTF = resolveHTF("sweep", tf, row.htf_override);
        const userHtfBias = userBiasTF ? biasByTF.get(userBiasTF) ?? "neutral" : "neutral";
        const alertMode = row.alert_mode ?? "aligned";
        const biasOverrides = JSON.parse(row.bias_overrides || "{}");
        const effectiveBias = getEffectiveBias(userBiasTF, { [userBiasTF]: { bias: userHtfBias } }, biasOverrides);
        const trendAligned = sweep.direction === effectiveBias;
        const shouldAlert = alertMode === "all" || alertMode === "price_action" || alertMode === "aligned" && trendAligned;
        if (!shouldAlert) {
          log(`[${symbol}] skipping \u2014 trend not aligned`);
          continue;
        }
        const tg = await env.DB.prepare(
          "SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1"
        ).bind(row.user_id).first();
        if (!tg?.chat_id) {
          console.log(`No verified Telegram for user ${row.user_id}`);
          continue;
        }
        const sweepMsg = formatSweepAlert({
          symbol,
          tf,
          direction: sweep.direction,
          candleTime: sweep.candleTime,
          trendBias: effectiveBias,
          trendAligned,
          sweptLevel: sweep.sweptLevel?.toFixed(5),
          closedInsideLevel: sweep.closedInsideLevel?.toFixed(5),
          trendMode: alertMode,
          biasTF: userBiasTF
        });
        await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, sweepMsg);
        console.log(`Sweep alert sent: ${symbol} ${tf} to user ${row.user_id}`);
        await env.DB.prepare(`
          INSERT INTO alert_history
          (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
          VALUES (?,?,?,?,?,?,?,?,'sweep')
        `).bind(
          crypto.randomUUID(),
          row.user_id,
          symbol,
          tf,
          sweep.direction,
          effectiveBias,
          sweep.candleTime,
          Date.now()
        ).run();
        const sweepChains = await getActiveChains(env.DB, row.user_id, symbol, "t3", sweep.direction, 2);
        for (const chain of sweepChains) {
          if (chain.ltf !== tf) continue;
          await advanceT3Chain(env.DB, chain.id, sweep.candleTime);
          const step2Msg = formatT3Alert(
            symbol,
            chain.htf_tf,
            tf,
            sweep.direction,
            deriveSession((/* @__PURE__ */ new Date()).toISOString()),
            sweep.closedInsideLevel ?? null,
            chain.htf_signal_id,
            2
          );
          await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, step2Msg);
        }
      }
      await new Promise((r) => setTimeout(r, 1e3));
    } catch (err) {
      console.error(`Error processing ${symbol} on ${tf}:`, err.message);
    }
  }
  console.log(`Sweep cron complete for ${tf}`);
}

var ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://ebp-tracker.pages.dev"
];
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Cron-Secret"
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
async function handleFetch(request, env) {
  const origin = request.headers.get("Origin") ?? "";
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (pathname === "/health") {
    return json({
      status: "ok",
      worker: "sweep-detector",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    }, 200, origin);
  }
  if (pathname === "/cron/sweep" && request.method === "POST") {
    const secret = request.headers.get("X-Cron-Secret");
    if (!secret || secret !== env.CRON_SECRET) {
      return json({ error: "Forbidden" }, 403, origin);
    }
    let body = {};
    try {
      body = await request.json();
    } catch {
    }
    const tf = body.tf ?? "M15";
    const validTFs = ["M15", "M30", "1H", "4H"];
    if (!validTFs.includes(tf)) {
      return json({ error: `Invalid TF: ${tf}. Must be one of ${validTFs.join(", ")}` }, 400, origin);
    }
    try {
      const debugLog = [];
      await handleSweepCron(tf, env, debugLog);
      return json({
        ok: true,
        tf,
        fired_at: (/* @__PURE__ */ new Date()).toISOString(),
        debug: debugLog
      }, 200, origin);
    } catch (err) {
      console.error(`Cron trigger error TF=${tf}:`, err.message);
      return json({ error: err.message, stack: err.stack }, 500, origin);
    }
  }
  return json({ error: "Not found", worker: "sweep-detector" }, 404, origin);
}
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      console.error("Unhandled fetch error:", err.message);
      return new Response(
        JSON.stringify({ error: "Internal server error", detail: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
  // Cloudflare scheduled handler — not used (cron-job.org handles scheduling)
  async scheduled(event, env, ctx) {
    console.log("Scheduled event received \u2014 scheduling handled via cron-job.org HTTP triggers");
  }
};

