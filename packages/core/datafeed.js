/**
 * Datafeed — Twelve Data primary, Yahoo Finance fallback.
 * Returns candles newest-first: [bar0 (latest closed), bar1, bar2]
 */

const TWELVE_DATA_BASE = 'https://api.twelvedata.com';

function toTwelveInterval(tf) {
  const map = {
    'M5': '5min', 'M15': '15min', 'M30': '30min',
    '1H': '1h', '4H': '4h', 'D': '1day', 'W': '1week',
  };
  return map[tf] ?? '1h';
}

function toYahooInterval(tf) {
  const map = {
    'M5': '5m', 'M15': '15m', 'M30': '30m',
    '1H': '1h', '4H': '1h', 'D': '1d', 'W': '1wk',
  };
  return map[tf] ?? '1h';
}

function toYahooSymbol(symbol) {
  const overrides = {
    'XAU/USD': 'GC=F',  'XAG/USD': 'SI=F',
    'WTI/USD': 'CL=F',  'BRENT/USD': 'BZ=F',
    'SPX': '^GSPC',     'DJI': '^DJI', 'NDX': '^NDX',
    'NIFTY': '^NSEI',   'SENSEX': '^BSESN',
  };
  if (overrides[symbol]) return overrides[symbol];
  if (symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    if (base.length <= 5 && quote === 'USD') return `${base}-USD`;
    return `${base}${quote}=X`;
  }
  if (symbol.endsWith('.NS') || symbol.endsWith('.BO')) return symbol;
  return symbol;
}

async function fetchTwelveData(symbol, tf, apiKey, outputSize = 3) {
  const interval = toTwelveInterval(tf);
  const params   = new URLSearchParams({
    symbol,
    interval,
    outputsize: outputSize,
    apikey: apiKey,
  });

  const res  = await fetch(`${TWELVE_DATA_BASE}/time_series?${params}`);
  const data = await res.json();

  if (data.status === 'error' || !data.values) {
    throw new Error(`Twelve Data error: ${data.message ?? 'no values'}`);
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

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json();

  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance: no data for ${symbol}`);

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

/**
 * Fetch last 3 candles with automatic fallback.
 * Returns [bar0(newest), bar1, bar2] or null on failure.
 */
export async function fetchCandles(symbol, tf, apiKey) {
  try {
    const candles = await fetchTwelveData(symbol, tf, apiKey, 3);
    if (candles.length >= 2) return candles;
    throw new Error('Insufficient candles from Twelve Data');
  } catch (primaryErr) {
    console.warn(`Twelve Data failed for ${symbol} ${tf}: ${primaryErr.message}. Trying Yahoo...`);
    try {
      const candles = await fetchYahooFinance(symbol, tf, 3);
      if (candles.length >= 2) return candles;
      throw new Error('Insufficient candles from Yahoo Finance');
    } catch (fallbackErr) {
      console.error(`Both sources failed for ${symbol} ${tf}:`, fallbackErr.message);
      return null;
    }
  }
}

/**
 * Validate symbol on either data source.
 * Returns { valid, source, displayName }
 */
export async function validateSymbol(symbol, apiKey) {
  try {
    const data = await fetchTwelveData(symbol, 'D', apiKey, 1);
    if (data?.length > 0) return { valid: true, source: 'twelve', displayName: symbol };
  } catch {}
  try {
    const data = await fetchYahooFinance(symbol, 'D', 1);
    if (data?.length > 0) return { valid: true, source: 'yahoo', displayName: symbol };
  } catch {}
  return { valid: false, source: null, displayName: null };
}
