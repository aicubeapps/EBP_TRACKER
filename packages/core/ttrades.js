// ============================================================
// TTrades Closure Bias Engine
// Port of Pine Script TTrades closure mechanic.
// Shared between EBP Worker and Sweep Worker.
// ============================================================

/**
 * Calculate TTrades closure bias from HTF candles.
 * @param {Object} p - { bar1, bar2 } each { open, high, low, close, time }
 *   bar1 = most recently closed HTF candle
 *   bar2 = candle before that (reference high/low)
 * @returns {{ bias: 'bullish'|'bearish'|'neutral', closure: string, closePos: number }}
 */
export function calcTTradesBias({ bar1, bar2 }) {
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

/**
 * Get HTF timeframe string for a given sweep alert TF (preset pairings).
 * Sweep Worker uses different pairings than EBP Worker.
 */
export function getHTFForSweepTF(tf) {
  const map = {
    'M5':  '1H',
    'M15': '1H',
    'M30': '4H',
    '1H':  'D',
    '4H':  'W',
  };
  return map[tf] ?? null;
}

/**
 * Get HTF timeframe string for a given EBP alert TF (preset pairings).
 */
export function getHTFForEBPTF(tf) {
  const map = {
    'M15': '4H',
    '1H':  'D',
    '4H':  'W',
    'D':   'W',
    'W':   null,
  };
  return map[tf] ?? null;
}

/**
 * Map internal TF string to Twelve Data interval parameter.
 */
export function tfToTwelveInterval(tf) {
  const map = {
    'M5':  '5min',
    'M15': '15min',
    'M30': '30min',
    '1H':  '1h',
    '4H':  '4h',
    'D':   '1day',
    'W':   '1week',
  };
  return map[tf] ?? '1h';
}

/**
 * DST helper — returns true if US is on Daylight Saving Time.
 * DST: 2nd Sunday March → 1st Sunday November
 */
export function isUSDST(date = new Date()) {
  const y      = date.getUTCFullYear();
  const m3     = new Date(Date.UTC(y, 2, 1));
  const dstStart = new Date(Date.UTC(y, 2, 1 + (7 - m3.getUTCDay()) % 7 + 7));
  const m11    = new Date(Date.UTC(y, 10, 1));
  const dstEnd = new Date(Date.UTC(y, 10, 1 + (7 - m11.getUTCDay()) % 7));
  return date >= dstStart && date < dstEnd;
}

/**
 * Returns UTC hour of NY market close (17:00 EST/EDT).
 */
export function getNYCloseUTCHour(date = new Date()) {
  return isUSDST(date) ? 21 : 22;
}