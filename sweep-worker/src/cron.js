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
      open:  ohlc.open[i],  high:  ohlc.high[i],
      low:   ohlc.low[i],   close: ohlc.close[i],
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
      throw new Error('Insufficient candles from Yahoo');
    } catch (e2) {
      console.error(`Both sources failed ${symbol} ${tf}: ${e2.message}`);
      return null;
    }
  }
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
  const emoji     = direction === 'bull' ? '🟢' : '🔴';
  const label     = direction === 'bull' ? 'BULL SWEEP' : 'BEAR SWEEP';
  const alignMark = trendAligned ? '✅' : trendMode === 'price_action' ? '📊 Price Action' : '⚠️ No Trend Filter';
  const swept     = direction === 'bull' ? 'Low swept' : 'High swept';
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
  const emoji    = direction === 'bull' ? '🟢' : '🔴';
  const bias     = direction === 'bull' ? 'BULLISH' : 'BEARISH';
  const alignMark = trendAligned ? '✅' : '⚠️ No Trend Filter';
  const elapsed  = ltfCandleTime && htfCandleTime
    ? Math.round((ltfCandleTime - htfCandleTime) / 60000) : null;
  const htfSweptLabel = direction === 'bull' ? 'Low swept' : 'High swept';
  const ltfSweptLabel = direction === 'bull' ? 'Low swept' : 'High swept';
  return `⚡ <b>COMBINED SIGNAL — ${symbol}</b>
━━━━━━━━━━━━━━
${emoji} <b>${bias} CONFLUENCE</b>
━━━━━━━━━━━━━━
HTF → <b>${htfTF} ${direction === 'bull' ? 'Bull' : 'Bear'} EBP</b>
🕐 ${fmtNY(htfCandleTime)} NY
📍 ${htfSweptLabel}: ${htfSwept}
📈 Closed ${direction === 'bull' ? 'above body' : 'below body'}: ${htfClosed}

LTF → <b>${ltfTF} ${direction === 'bull' ? 'Bull' : 'Bear'} Sweep</b>
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
    direction:         bullSweep ? 'bull' : 'bear',
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

// ── Main cron handler ─────────────────────────────────────────

export async function handleSweepCron(tf, env) {
  console.log(`Sweep trigger → TF: ${tf}`);

  if (tf === 'M5') {
    await cleanupExpiredSignals(env.DB);
    console.log('Cleaned up expired pending signals');
  }

  const rows = await env.DB.prepare(`
    SELECT ua.id as asset_id, ua.symbol,
           ua.sweep_alert_mode, ua.sweep_timeframes,
           ua.combined_enabled, ua.combined_pairs, ua.combined_window_mins,
           u.id as user_id, u.active as user_active
    FROM user_assets ua
    JOIN users u ON u.id = ua.user_id
    WHERE ua.active = 1 AND ua.sweep_enabled = 1 AND u.active = 1
  `).all();

  const filtered = (rows.results ?? []).filter(r =>
    r.sweep_timeframes?.split(',').map(t => t.trim()).includes(tf)
  );

  if (!filtered.length) {
    console.log(`No sweep assets configured for ${tf}`);
    return;
  }

  console.log(`Processing ${filtered.length} asset-user pairs on ${tf}`);

  const symbolMap = new Map();
  for (const row of filtered) {
    if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, []);
    symbolMap.get(row.symbol).push(row);
  }

  const htfTF = getHTFForSweepTF(tf);

  for (const [symbol, userRows] of symbolMap) {
    try {
      const candles = await fetchCandles(symbol, tf, env.TWELVE_DATA_API_KEY);
      if (!candles || candles.length < 2) {
        console.warn(`Insufficient candles for ${symbol} ${tf}`);
        continue;
      }

      let htfBias = 'neutral';
      if (htfTF) {
        const htfCandles = await fetchCandles(symbol, htfTF, env.TWELVE_DATA_API_KEY);
        if (htfCandles?.length >= 3) {
          const result = calcTTradesBias({ bar1: htfCandles[1], bar2: htfCandles[2] });
          htfBias = result.bias;
        }
      }

      await updateSweepCandleCache(env.DB, symbol, tf, candles);

      const sweep = detectSweep(candles);
      if (!sweep) {
        console.log(`No sweep on ${symbol} ${tf}`);
        continue;
      }

      console.log(`Sweep detected: ${symbol} ${tf} ${sweep.direction} (HTF bias: ${htfBias})`);

      for (const row of userRows) {
        const alertMode    = row.sweep_alert_mode ?? 'aligned';
        const trendAligned = sweep.direction === 'bull'
          ? htfBias === 'bullish'
          : htfBias === 'bearish';

        const shouldAlert =
          alertMode === 'all' ||
          alertMode === 'price_action' ||
          (alertMode === 'aligned' && trendAligned);

        if (!shouldAlert) {
          console.log(`Skipping ${symbol} — trend not aligned`);
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
          trendBias:         htfBias,
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
          sweep.direction, htfBias, sweep.candleTime, Date.now()
        ).run();

        if (row.combined_enabled) {
          const pendingMatches = await checkPendingSignals(
            env.DB, row.user_id, symbol, sweep.direction, tf
          );
          for (const { signal, pairKey } of pendingMatches) {
            const htfCache = await env.DB.prepare(`
              SELECT bar_0_high, bar_0_low, bar_0_close,
                     bar_1_high, bar_1_low, bar_1_open, bar_1_close, bar_0_time
              FROM candle_cache WHERE symbol = ? AND timeframe = ?
            `).bind(symbol, signal.timeframe).first();

            const htfBodyHigh = htfCache
              ? Math.max(htfCache.bar_1_open ?? 0, htfCache.bar_1_close ?? 0) : null;
            const htfBodyLow  = htfCache
              ? Math.min(htfCache.bar_1_open ?? 0, htfCache.bar_1_close ?? 0) : null;

            const combinedMsg = formatCombinedAlert({
              symbol, htfTF: signal.timeframe, ltfTF: tf,
              direction: sweep.direction,
              htfCandleTime: signal.fired_at,
              ltfCandleTime: sweep.candleTime,
              trendBias: htfBias, trendAligned,
              htfSwept: sweep.direction === 'bull'
                ? htfCache?.bar_1_low?.toFixed(5)  ?? '—'
                : htfCache?.bar_1_high?.toFixed(5) ?? '—',
              htfClosed: sweep.direction === 'bull'
                ? htfBodyHigh?.toFixed(5) ?? '—'
                : htfBodyLow?.toFixed(5)  ?? '—',
              ltfSwept:  sweep.sweptLevel?.toFixed(5),
              ltfClosed: sweep.closedInsideLevel?.toFixed(5),
            });

            await sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, combinedMsg);

            await env.DB.prepare(`
              INSERT INTO alert_history
              (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
              VALUES (?,?,?,?,?,?,?,?,'combined')
            `).bind(
              crypto.randomUUID(), row.user_id, symbol,
              `${signal.timeframe}+${tf}`,
              sweep.direction, htfBias, sweep.candleTime, Date.now()
            ).run();

            await consumePendingSignal(env.DB, signal.id, pairKey);
            console.log(`Combined alert sent: ${symbol} ${signal.timeframe}+${tf}`);
          }
        }
      }

      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`Error processing ${symbol} on ${tf}:`, err.message);
    }
  }

  console.log(`Sweep cron complete for ${tf}`);
}