const TELEGRAM_BASE = 'https://api.telegram.org';

export async function sendTelegramMessage(botToken, chatId, text) {
  const res = await fetch(`${TELEGRAM_BASE}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${data.description}`);
  return data;
}

export function formatEBPAlert({ symbol, timeframe, direction, closure, closePos, trendBias, htfTf }) {
  const arrow  = direction === 'bull' ? '🟢' : '🔴';
  const label  = direction === 'bull' ? 'BULLISH EBP' : 'BEARISH EBP';
  const biasIc = trendBias === 'bullish' ? '↑' : trendBias === 'bearish' ? '↓' : '—';
  const aligned = (direction === 'bull' && trendBias === 'bullish') ||
                  (direction === 'bear' && trendBias === 'bearish');

  return [
    `${arrow} <b>${label}</b>`,
    `<b>Symbol:</b> ${symbol}`,
    `<b>Timeframe:</b> ${timeframe}`,
    `<b>Closure:</b> ${closure.replace(/_/g, ' ')}  (close @ ${closePos.toFixed(0)}%)`,
    htfTf ? `<b>HTF Bias (${htfTf}):</b> ${biasIc} ${trendBias}${aligned ? ' ✅ Aligned' : ''}` : '',
  ].filter(Boolean).join('\n');
}

export function formatSweepAlert({ symbol, timeframe, direction, closure, closePos }) {
  const arrow = direction === 'bull' ? '🟢' : '🔴';
  const label = direction === 'bull' ? 'BULLISH SWEEP' : 'BEARISH SWEEP';
  return [
    `${arrow} <b>${label}</b>`,
    `<b>Symbol:</b> ${symbol}`,
    `<b>Timeframe:</b> ${timeframe}`,
    `<b>Type:</b> ${closure.replace(/_/g, ' ')}  (close @ ${closePos.toFixed(0)}%)`,
  ].join('\n');
}

export function formatCombinedAlert({ symbol, direction, signals }) {
  const arrow = direction === 'bull' ? '🟢' : '🔴';
  const label = direction === 'bull' ? 'COMBINED BULLISH' : 'COMBINED BEARISH';
  const lines = signals.map(s => `  • ${s.timeframe} — ${s.type}`);
  return [
    `${arrow} <b>${label} CONFLUENCE</b>`,
    `<b>Symbol:</b> ${symbol}`,
    `<b>Signals:</b>`,
    ...lines,
  ].join('\n');
}
