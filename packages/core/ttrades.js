/**
 * TTrades Closure Bias Engine
 * Port of Pine Script TTrades closure mechanic.
 *
 * @param {Object} htfCandles - { bar0, bar1, bar2 } each with { open, high, low, close, time }
 *   bar0 = most recent closed candle
 *   bar1 = previous candle (the one being evaluated)
 *   bar2 = candle before that (reference high/low)
 * @returns {{ bias: 'bullish'|'bearish'|'neutral', closure: string, closePos: number }}
 */
export function calcTTradesBias(htfCandles) {
  const { bar1, bar2 } = htfCandles;

  const c0    = bar1.close;
  const h0    = bar1.high;
  const l0    = bar1.low;
  const prevH = bar2.high;
  const prevL = bar2.low;

  const sweptH   = h0 > prevH && c0 <= prevH;
  const sweptL   = l0 < prevL && c0 >= prevL;
  const insideD  = h0 <= prevH && l0 >= prevL;
  const outsideD = h0 > prevH && l0 < prevL;
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
 * Get HTF timeframe string for a given alert TF (preset pairings)
 */
export function getHTFForTF(tf) {
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
 * Map TF string to Twelve Data interval param
 */
export function tfToInterval(tf) {
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
