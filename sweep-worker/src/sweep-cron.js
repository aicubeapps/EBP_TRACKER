// ============================================================
// Sweep Worker Cron Handler — Standalone (no external imports)
// All core functions inlined to avoid Wrangler bundling issues
// with cross-package relative imports.
// ============================================================

// ── TTrades Closure Bias (inlined from packages/core/ttrades.js) ──

function calcTTradesBias({ bar1, bar2 }) {
  const c0    = bar1.close;
  const h0    = bar1.high;
  const l0    = bar1.low;
  const prevH = bar2.high;
  const prevL = bar2.low;

  const sweptH   = h0 > prevH && c0 <= prevH;
  const sweptL   = l0 < prevL && c0 >= prevL;
  const insideD  = h0 <= prevH && l0 >= prevL;
  const outsideD = h0 > prevH  && l0 < prevL;
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

function getHTFForSweepTF(tf) {
  const map = { 'M5': '1H', 'M15': '1H', 'M30': '4H', '1H': 'D', '4H': 'W' };
  return map[tf] ?? null;
}

// ── Phase 3 — Bias Source Map ─────────────────────────────────
const BIAS_SOURCE = {
  ebp:      { 'M15': '4H', '1H': 'D', '4H': 'W', 'D': 'W', 'W': null },
  sweep:    { 'M5': '1H', 'M15': '1H', 'M30': '4H', '1H': 'D', '4H': 'W' },
  template: { 'W': null, 'D': 'W', '4H': 'D', '1H': '4H' },
};

function getEffectiveBias(biasTF, biasCache, biasOverrides) {
  if (!biasTF) return 'neutral';
  const override = biasOverrides?.[biasTF];
  if (override && override !== 'auto') return override;
  return biasCache?.[biasTF]?.bias ?? 'neutral';
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

async function loadBiasCache(db, symbol, biasTF) {
  return db.prepare(
    'SELECT * FROM bias_cache WHERE symbol=? AND timeframe=?'
  ).bind(symbol, biasTF).first();
}

// ── Phase 3 — T3 Chain State Machine ─────────────────────────

async function initiateT3Chain(db, userId, assetId, symbol, direction, htfTf, ltf, windowMins) {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO chain_state
    (id,user_id,asset_id,symbol,template,direction,current_step,htf_tf,ltf,htf_signal_time,expires_at,created_at)
    VALUES (?,?,?,?,?,?,2,?,?,?,?,?)
  `).bind(
    crypto.randomUUID(), userId, assetId, symbol,
    't3', direction, htfTf, ltf, now,
    now + (windowMins * 60 * 1000), now
  ).run();
}

async function advanceT3Chain(db, chainId, ltfSweepTime) {
  await db.prepare(
    'UPDATE chain_state SET current_step=3, ltf_sweep_time=? WHERE id=?'
  ).bind(ltfSweepTime, chainId).run();
}

async function completeT3Chain(db, chainId) {
  await db.prepare('DELETE FROM chain_state WHERE id=?').bind(chainId).run();
}

async function getActiveChains(db, userId, symbol, template, direction, step) {
  const res = await db.prepare(`
    SELECT * FROM chain_state
    WHERE user_id=? AND symbol=? AND template=? AND direction=? AND current_step=? AND expires_at > ?
  `).bind(userId, symbol, template, direction, step, Date.now()).all();
  return res.results ?? [];
}

async function cleanupExpiredChains(db) {
  await db.prepare('DELETE FROM chain_state WHERE expires_at < ?').bind(Date.now()).run();
}

function formatT3Alert(symbol, direction, htfTf, ltfTf, htfBar, ltfBar, mssBar) {
  const dir     = direction === 'bullish' ? '🟢 Bullish' : '🔴 Bearish';
  const htfTime = new Date(htfBar.time).toUTCString().slice(5, 22);
  const ltfTime = new Date(ltfBar.time).toUTCString().slice(5, 22);
  const mssTime = new Date(mssBar.time).toUTCString().slice(5, 22);
  return [
    `⛓ T3 Chain Complete — ${symbol}`,
    `Direction: ${dir}`,
    `Step 1 — ${htfTf} EBP: ${htfTime}`,
    `Step 2 — ${ltfTf} Sweep: ${ltfTime}`,
    `Step 3 — ${ltfTf} MSS: ${mssTime}`,
  ].join('\n');
}

function tfToTwelveInterval(tf) {
  const map = {
    'M5': '5min', 'M15': '15min', 'M30': '30min',
    '1H': '1h', '4H': '4h', 'D': '1day', 'W': '1week',
  };
  return map[tf] ?? '1h';
}

// ── Data Feed (inlined from packages/core/datafeed.js) ───────

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
      open:  ohlc.open[i],  high:  ohlc.high[i],
      low:   ohlc.low[i],   close: ohlc.close[i],
      time:  timestamps[i] * 1000,
    });
  }
  return candles;
}

async function logApiCall(db, source, symbol, timeframe, success = 1) {
  try {
    await db.prepare(
      'INSERT INTO api_call_log (id, source, symbol, timeframe, called_at, success) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), source, symbol, timeframe, Date.now(), success).run();
  } catch {}
}

// ── Twelve Data key rotation ──────────────────────────────
// Keys live in D1 (api_keys, source='twelvedata') rather than being a fixed
// env-var list, so rotation works dynamically regardless of how many keys
// are configured. A key that comes back exhausted (daily credit cap) is
// marked and skipped until the next UTC midnight instead of failing the
// whole fetch. Falls through to Yahoo only once every key is exhausted.

function nextMidnightUTC() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
}

async function resetExhaustedKeys(db) {
  const now = Date.now();
  await db.prepare(
    `UPDATE api_key_state
     SET exhausted=0, calls_today=0, exhausted_at=NULL, reset_at=?
     WHERE exhausted=1 AND reset_at < ?`
  ).bind(nextMidnightUTC(), now).run();
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

function isTwelveDataExhausted(data) {
  if (data?.code === 429) return true;
  if (data?.status === 'error' && data?.message?.toLowerCase().includes('run out')) return true;
  if (data?.status === 'error' && data?.message?.toLowerCase().includes('api credits')) return true;
  return false;
}

async function fetchTwelveDataWithRotation(symbol, tf, db, env, _log = null, count = 10) {
  const interval = tfToTwelveInterval(tf);

  const maxAttempts = 5; // safety cap — more than the realistic key count
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const active = await getActiveTwelveDataKey(db);
    if (!active) break; // all keys exhausted (or none configured)

    await ensureKeyStateRow(db, active.keyName);

    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${count}&order=DESC&timezone=America/New_York&apikey=${active.apiKey}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (_log) _log.push(`[WARN] Twelve Data HTTP ${res.status} for ${symbol} ${tf} on ${active.label}`);
        return null;
      }

      const data = await res.json();

      if (isTwelveDataExhausted(data)) {
        await markKeyExhausted(db, active.keyName);
        if (_log) _log.push(`[WARN] ${active.label} exhausted — rotating`);
        continue; // try next key
      }

      if (data.status === 'error' || !data.values || data.values.length < 3) {
        if (_log) _log.push(`[WARN] Twelve Data no data for ${symbol} ${tf} on ${active.label}: ${data.message ?? 'unknown'}`);
        return null; // symbol error — don't rotate, just fail
      }

      await incrementKeyCallCount(db, active.keyName);
      await logApiCall(db, active.keyName, symbol, tf, 1);

      return data.values.map(v => ({
        open:  parseFloat(v.open),
        high:  parseFloat(v.high),
        low:   parseFloat(v.low),
        close: parseFloat(v.close),
        time:  new Date(v.datetime).getTime(),
      }));

    } catch (e) {
      if (_log) _log.push(`[ERROR] Twelve Data fetch error ${symbol} ${tf} on ${active.label}: ${e.message}`);
      return null;
    }
  }

  return null; // all keys exhausted or failed
}

// Bare 6-char pairs (GBPUSD, XAUUSD, ...) fall through every data source
// unchanged — toYahooSymbol() only translates slash-delimited symbols.
// Normalise to BASE/QUOTE so those lookups actually resolve.
function normaliseSymbol(symbol) {
  if (!symbol) return symbol;
  if (symbol.includes('/')) return symbol; // already slash format

  const FOREX_BASES  = ['EUR', 'GBP', 'USD', 'AUD', 'NZD', 'CAD', 'CHF', 'JPY', 'XAU', 'XAG', 'BTC', 'ETH', 'SOL'];
  const FOREX_QUOTES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

  const upper = symbol.toUpperCase();

  for (const base of FOREX_BASES) {
    for (const quote of FOREX_QUOTES) {
      if (upper === base + quote && base !== quote) {
        return `${base}/${quote}`;
      }
    }
  }

  return symbol; // NSE stocks / indices etc. — passthrough
}

async function fetchCandles(symbol, tf, db, env, _log = null, count = 10) {
  symbol = normaliseSymbol(symbol);

  // 1. Twelve Data — primary (3-key rotation)
  const twelveCandles = await fetchTwelveDataWithRotation(symbol, tf, db, env, _log, count);
  if (twelveCandles && twelveCandles.length >= 3) return twelveCandles;
  if (_log) _log.push(`[WARN] Twelve Data failed ${symbol} ${tf} — trying Yahoo`);

  // 2. Yahoo Finance — final fallback (unlimited, no key)
  try {
    const c = await fetchYahooFinance(symbol, tf, count);
    if (c && c.length >= 3) {
      await logApiCall(db, 'yahoo', symbol, tf);
      return c;
    }
  } catch (e) {
    if (_log) _log.push(`[WARN] Yahoo failed ${symbol} ${tf}: ${e.message}`);
  }

  const msg = `All sources failed ${symbol} ${tf}`;
  console.error(msg);
  if (_log) _log.push(`[ERROR] ${msg}`);
  return null;
}

// ── Telegram (inlined from packages/core/telegram.js) ────────

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

function fmtNY(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit',
    hour12: true, month: 'short', day: 'numeric',
  });
}

function getHTFLabel(tf) {
  const map = { 'M5': '1H', 'M15': '1H', 'M30': '4H', '1H': 'Daily', '4H': 'Weekly', 'D': 'Weekly', 'W': 'Raw' };
  return map[tf] ?? 'HTF';
}

function formatSweepAlert({ symbol, tf, direction, candleTime, trendBias, trendAligned, sweptLevel, closedInsideLevel, trendMode }) {
  const emoji     = direction === 'bullish' ? '🟢' : '🔴';
  const label     = direction === 'bullish' ? 'BULLISH SWEEP' : 'BEARISH SWEEP';
  const alignMark = trendAligned ? '✅' : trendMode === 'price_action' ? '📊 Price Action' : '⚠️ No Trend Filter';
  const swept     = direction === 'bullish' ? 'Low swept' : 'High swept';
  return `${emoji} <b>${label} — ${symbol}</b>
⏱ Timeframe: ${tf}
🕐 Candle: ${fmtNY(candleTime)} NY
📊 Trend: ${trendBias} (${getHTFLabel(tf)} bias) ${alignMark}
━━━━━━━━━━━━━━
${swept}: ${sweptLevel}
Closed inside: ${closedInsideLevel}
━━━━━━━━━━━━━━
<i>EBP Tracker</i>`;
}

function formatCombinedAlert({ symbol, htfTF, ltfTF, direction, htfCandleTime, ltfCandleTime, trendBias, trendAligned, htfSwept, htfClosed, ltfSwept, ltfClosed }) {
  const emoji    = direction === 'bullish' ? '🟢' : '🔴';
  const bias     = direction === 'bullish' ? 'BULLISH' : 'BEARISH';
  const alignMark = trendAligned ? '✅' : '⚠️ No Trend Filter';
  const elapsed  = ltfCandleTime && htfCandleTime
    ? Math.round((ltfCandleTime - htfCandleTime) / 60000) : null;
  const htfSweptLabel = direction === 'bullish' ? 'Low swept' : 'High swept';
  const ltfSweptLabel = direction === 'bullish' ? 'Low swept' : 'High swept';
  return `⚡ <b>COMBINED SIGNAL — ${symbol}</b>
━━━━━━━━━━━━━━
${emoji} <b>${bias} CONFLUENCE</b>
━━━━━━━━━━━━━━
HTF → <b>${htfTF} ${direction === 'bullish' ? 'Bullish' : 'Bearish'} EBP</b>
🕐 ${fmtNY(htfCandleTime)} NY
📍 ${htfSweptLabel}: ${htfSwept}
📈 Closed ${direction === 'bullish' ? 'above body' : 'below body'}: ${htfClosed}

LTF → <b>${ltfTF} ${direction === 'bullish' ? 'Bullish' : 'Bearish'} Sweep</b>
🕐 ${fmtNY(ltfCandleTime)} NY
📍 ${ltfSweptLabel}: ${ltfSwept}
📈 Closed inside: ${ltfClosed}
${elapsed !== null ? `\n⏱ Confluence: ${elapsed} min` : ''}
📊 Trend: ${trendBias} ${alignMark}
━━━━━━━━━━━━━━
<i>EBP Tracker</i>`;
}

// ── Sweep Detection (inlined from sweep.js) ──────────────────

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

async function updateSweepCandleCache(db, symbol, tf, candles) {
  const [b0, b1, b2] = candles;
  await db.prepare(`
    INSERT OR REPLACE INTO sweep_candle_cache
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

async function checkPendingSignals(db, userId, symbol, direction, ltfTF) {
  const now     = Date.now();
  const pending = await db.prepare(`
    SELECT * FROM pending_signals
    WHERE user_id = ? AND symbol = ? AND direction = ? AND expires_at > ?
    ORDER BY fired_at DESC LIMIT 10
  `).bind(userId, symbol, direction, now).all();

  if (!pending.results?.length) return [];

  const matches = [];
  for (const signal of pending.results) {
    const consumedPairs = JSON.parse(signal.consumed_pairs ?? '[]');
    const pairKey       = `${signal.timeframe}:${ltfTF}`;
    if (consumedPairs.includes(pairKey)) continue;

    const asset = await db.prepare(`
      SELECT combined_pairs, combined_enabled
      FROM user_assets
      WHERE user_id = ? AND symbol = ? AND active = 1
    `).bind(userId, symbol).first();

    if (!asset?.combined_enabled) continue;

    const userPairs = JSON.parse(asset.combined_pairs ?? '[]');
    const pairMatch = userPairs.find(p => p.htf === signal.timeframe && p.ltf === ltfTF);
    if (pairMatch) matches.push({ signal, pairKey });
  }
  return matches;
}

async function consumePendingSignal(db, signalId, pairKey) {
  const signal = await db.prepare(
    'SELECT consumed_pairs FROM pending_signals WHERE id = ?'
  ).bind(signalId).first();
  if (!signal) return;
  const consumed = JSON.parse(signal.consumed_pairs ?? '[]');
  consumed.push(pairKey);
  await db.prepare(
    'UPDATE pending_signals SET consumed_pairs = ? WHERE id = ?'
  ).bind(JSON.stringify(consumed), signalId).run();
}

async function cleanupExpiredSignals(db) {
  await db.prepare('DELETE FROM pending_signals WHERE expires_at < ?').bind(Date.now()).run();
}

// ── Swing State + MSS Engine (Phase 1.5 + 2, inlined) ────────

function getCandleDirection(candle, priorDirection) {
  if (candle.close > candle.open) return 'bullish';
  if (candle.close < candle.open) return 'bearish';
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
  } catch (e) {
    console.error(`[SWING] ERROR ${symbol} ${timeframe}: ${e.message}\n${e.stack}`);
    return null;
  }
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

// ── FVG Engine (Phase 1, inlined) ────────────────────────────

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
  try {
  console.log(`[FVG] Processing ${symbol} ${timeframe}`);
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
  } catch (e) {
    console.error(`[FVG] ERROR ${symbol} ${timeframe}: ${e.message}\n${e.stack}`);
  }
}

async function cleanupExpiredFVGs(db) {
  const now = Date.now();
  await db.prepare(`UPDATE detected_fvgs SET mitigated=1, mitigated_at=? WHERE mitigated=0 AND expires_at<?`)
    .bind(now, now).run();
}

// ── Main cron handler ─────────────────────────────────────────

export async function handleSweepCron(tf, env, debugLog = null) {
  const log = (msg) => { console.log(msg); if (debugLog) debugLog.push(msg); };
  log(`Sweep trigger → TF: ${tf}`);

  if (tf === 'M5') {
    await cleanupExpiredSignals(env.DB);
    await cleanupExpiredFVGs(env.DB);
    await cleanupExpiredChains(env.DB);
    await resetExhaustedKeys(env.DB); // in case midnight UTC has passed
    await env.DB.prepare(
      `DELETE FROM api_call_log WHERE called_at < ?`
    ).bind(Date.now() - (2 * 24 * 60 * 60 * 1000)).run();
    log('Cleaned up expired pending signals, FVGs, chains, key state, and API call log');
  }

  const { results: filtered } = await env.DB.prepare(`
    SELECT sc.id as config_id, sc.alert_mode,
           ua.id as asset_id, ua.symbol, ua.bias_overrides,
           u.id as user_id, u.active as user_active
    FROM user_sweep_configs sc
    JOIN user_assets ua ON sc.asset_id = ua.id
    JOIN users u ON sc.user_id = u.id
    WHERE sc.timeframe=? AND sc.enabled=1
    AND ua.active=1 AND u.active=1
  `).bind(tf).all();

  if (!filtered?.length) {
    log(`No sweep assets configured for ${tf}`);
    return;
  }

  log(`Processing ${filtered.length} asset-user pairs on ${tf}`);

  const symbolMap = new Map();
  for (const row of filtered) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, []);
    symbolMap.get(row.symbol).push(row);
  }

  const biasTF = BIAS_SOURCE.sweep[tf] ?? null;

  for (const [symbol, userRows] of symbolMap) {
    try {
      const candles = await fetchCandles(symbol, tf, env.DB, env, debugLog, 10);
      log(`[${symbol}] candles fetched: ${candles?.length ?? 'null'}`);
      if (!candles || candles.length < 2) {
        log(`[${symbol}] SKIP: insufficient candles`);
        continue;
      }

      let htfBias = 'neutral';
      if (biasTF) {
        const htfCandles = await fetchCandles(symbol, biasTF, env.DB, env, debugLog, 10);
        log(`[${symbol}] htf candles fetched: ${htfCandles?.length ?? 'null'}`);
        if (htfCandles?.length >= 2) {
          const biasResult = calcTTradesBias({ bar1: htfCandles[0], bar2: htfCandles[1] });
          biasResult.bar1Time = htfCandles[0].time;
          htfBias = biasResult.bias;
          await writeBiasCache(env.DB, symbol, biasTF, biasResult);
        }
      }

      await updateSweepCandleCache(env.DB, symbol, tf, candles);

      // FVG Phase 1 + Swing/MSS Phase 1.5+2 — candles are newest-first; need oldest-first
      if (candles.length >= 3) {
        log(`[${symbol}] running FVG + swing (3 candles available)`);
        const oldestFirst = [candles[2], candles[1], candles[0]];
        await processFVGs(env.DB, symbol, tf, oldestFirst, candles[0]);

        const mssResult = await updateSwingState(env.DB, symbol, tf, oldestFirst);
        log(`[${symbol}] MSS result: ${mssResult ? mssResult.direction : 'none'}`);
        if (mssResult) {
          const htfLabelStr = getHTFLabel(tf);
          for (const row of userRows) {
            const alertMode     = row.alert_mode ?? 'aligned';
            const biasOverrides = JSON.parse(row.bias_overrides || '{}');
            const effectiveBias = getEffectiveBias(biasTF, { [biasTF]: { bias: htfBias } }, biasOverrides);
            const shouldAlert   = alertMode === 'all' || alertMode === 'price_action' ||
                                  mssResult.direction === effectiveBias || effectiveBias === 'neutral';
            if (!shouldAlert) continue;

            const tg = await env.DB.prepare(
              'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
            ).bind(row.user_id).first();
            if (!tg?.chat_id) continue;

            const msg = formatMSSAlert(symbol, tf, mssResult, effectiveBias, htfLabelStr);
            await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, msg);

            await env.DB.prepare(
              `INSERT INTO alert_history
               (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
               VALUES (?,?,?,?,?,?,?,?,'mss')`
            ).bind(
              crypto.randomUUID(), row.user_id, symbol, tf,
              mssResult.direction, effectiveBias, mssResult.candle_time, Date.now()
            ).run();

            // T3 step 3 — MSS completes the chain
            const mssChains = await getActiveChains(env.DB, row.user_id, symbol, 't3', mssResult.direction, 3);
            for (const chain of mssChains) {
              if (chain.ltf !== tf) continue;
              const t3Msg = formatT3Alert(
                symbol, mssResult.direction,
                chain.htf_tf, tf,
                { time: chain.htf_signal_time },
                { time: chain.ltf_sweep_time },
                { time: mssResult.candle_time }
              );
              await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, t3Msg);
              await env.DB.prepare(`
                INSERT INTO alert_history
                (id,user_id,symbol,timeframe,direction,trend_bias,candle_time,fired_at,alert_type)
                VALUES (?,?,?,?,?,?,?,?,'t3')
              `).bind(
                crypto.randomUUID(), row.user_id, symbol,
                `${chain.htf_tf}+${tf}`,
                mssResult.direction, effectiveBias, mssResult.candle_time, Date.now()
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
        const alertMode     = row.alert_mode ?? 'aligned';
        const biasOverrides = JSON.parse(row.bias_overrides || '{}');
        const effectiveBias = getEffectiveBias(biasTF, { [biasTF]: { bias: htfBias } }, biasOverrides);
        const trendAligned  = sweep.direction === effectiveBias;

        const shouldAlert =
          alertMode === 'all' ||
          alertMode === 'price_action' ||
          (alertMode === 'aligned' && trendAligned);

        if (!shouldAlert) {
          log(`[${symbol}] skipping — trend not aligned`);
          continue;
        }

        const tg = await env.DB.prepare(
          'SELECT chat_id FROM user_telegram WHERE user_id = ? AND verified = 1'
        ).bind(row.user_id).first();

        if (!tg?.chat_id) {
          console.log(`No verified Telegram for user ${row.user_id}`);
          continue;
        }

        const sweepMsg = formatSweepAlert({
          symbol, tf,
          direction:         sweep.direction,
          candleTime:        sweep.candleTime,
          trendBias:         effectiveBias,
          trendAligned,
          sweptLevel:        sweep.sweptLevel?.toFixed(5),
          closedInsideLevel: sweep.closedInsideLevel?.toFixed(5),
          trendMode:         alertMode,
        });

        await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, sweepMsg);
        console.log(`Sweep alert sent: ${symbol} ${tf} to user ${row.user_id}`);

        await env.DB.prepare(`
          INSERT INTO alert_history
          (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
          VALUES (?,?,?,?,?,?,?,?,'sweep')
        `).bind(
          crypto.randomUUID(), row.user_id, symbol, tf,
          sweep.direction, effectiveBias, sweep.candleTime, Date.now()
        ).run();

        // T3 step 2 — sweep advances an active chain
        const sweepChains = await getActiveChains(env.DB, row.user_id, symbol, 't3', sweep.direction, 2);
        for (const chain of sweepChains) {
          if (chain.ltf !== tf) continue;
          await advanceT3Chain(env.DB, chain.id, sweep.candleTime);
        }
      }

      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`Error processing ${symbol} on ${tf}:`, err.message);
    }
  }

  console.log(`Sweep cron complete for ${tf}`);
}