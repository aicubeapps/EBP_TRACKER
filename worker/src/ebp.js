import { calcTTradesBias, getHTFForTF } from '../../packages/core/ttrades.js';
import { fetchCandles } from '../../packages/core/datafeed.js';

function detectEBP(bar0, bar1) {
  const prevBodyHigh = Math.max(bar1.open, bar1.close);
  const prevBodyLow  = Math.min(bar1.open, bar1.close);
  if (bar0.low < bar1.low && bar0.close > prevBodyHigh) return 'bull';
  if (bar0.high > bar1.high && bar0.close < prevBodyLow) return 'bear';
  return null;
}

/**
 * Fetch candles and run EBP detection for one symbol/timeframe.
 * Returns { direction, trendBias, htfTf, closure, closePos, candleTime } or null.
 */
export async function checkEBP(symbol, tf, apiKey, env) {
  const candles = await fetchCandles(symbol, tf, apiKey);
  if (!candles || candles.length < 2) return null;

  const [bar0, bar1] = candles;
  const direction = detectEBP(bar0, bar1);
  if (!direction) return null;

  let trendBias = 'neutral';
  let closure   = 'none';
  let closePos  = 50;
  let htfTf     = null;

  const htf = getHTFForTF(tf);
  if (htf) {
    htfTf = htf;
    const htfCandles = await fetchCandles(symbol, htf, apiKey);
    if (htfCandles && htfCandles.length >= 3) {
      const result = calcTTradesBias({ bar0: htfCandles[0], bar1: htfCandles[1], bar2: htfCandles[2] });
      trendBias = result.bias;
      closure   = result.closure;
      closePos  = result.closePos;
    }
  }

  await cacheCandles(env, symbol, tf, candles);

  return { direction, trendBias, htfTf, closure, closePos, candleTime: bar0.time };
}

async function cacheCandles(env, symbol, tf, candles) {
  const [b0, b1, b2] = candles;
  try {
    await env.DB.prepare(`
      INSERT INTO candle_cache
        (symbol, timeframe,
         bar_0_open, bar_0_high, bar_0_low, bar_0_close,
         bar_1_open, bar_1_high, bar_1_low, bar_1_close,
         bar_2_open, bar_2_high, bar_2_low, bar_2_close,
         bar_0_time, bar_1_time, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(symbol, timeframe) DO UPDATE SET
        bar_0_open=excluded.bar_0_open, bar_0_high=excluded.bar_0_high,
        bar_0_low=excluded.bar_0_low,   bar_0_close=excluded.bar_0_close,
        bar_1_open=excluded.bar_1_open, bar_1_high=excluded.bar_1_high,
        bar_1_low=excluded.bar_1_low,   bar_1_close=excluded.bar_1_close,
        bar_2_open=excluded.bar_2_open, bar_2_high=excluded.bar_2_high,
        bar_2_low=excluded.bar_2_low,   bar_2_close=excluded.bar_2_close,
        bar_0_time=excluded.bar_0_time, bar_1_time=excluded.bar_1_time,
        updated_at=excluded.updated_at
    `).bind(
      symbol, tf,
      b0.open, b0.high, b0.low, b0.close,
      b1?.open, b1?.high, b1?.low, b1?.close,
      b2?.open, b2?.high, b2?.low, b2?.close,
      b0.time, b1?.time, Date.now()
    ).run();
  } catch (e) {
    console.warn('candle_cache write failed:', e.message);
  }
}

export async function wasAlertFired(env, userId, symbol, tf, direction, candleTime) {
  const row = await env.DB.prepare(`
    SELECT id FROM alert_history
    WHERE user_id=? AND symbol=? AND timeframe=? AND direction=? AND candle_time=?
    LIMIT 1
  `).bind(userId, symbol, tf, direction, candleTime).first();
  return !!row;
}

export async function recordAlert(env, userId, symbol, tf, direction, trendBias, candleTime, alertType = 'ebp') {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO alert_history (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(id, userId, symbol, tf, direction, trendBias, candleTime, Date.now(), alertType).run();
}
