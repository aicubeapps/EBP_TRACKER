import { checkEBP, wasAlertFired, recordAlert } from './ebp.js';
import { sendTelegramMessage, formatEBPAlert } from '../../packages/core/telegram.js';

const CRON_TF_MAP = {
  '*/15 * * * *': ['M15'],
  '0 * * * *':    ['1H'],
  '0 */4 * * *':  ['4H'],
  '0 21 * * 1-5': ['D'],
  '0 21 * * 5':   ['W'],
};

export async function handleCron(cron, env) {
  const tfs = CRON_TF_MAP[cron];
  if (!tfs) { console.warn('Unknown cron:', cron); return; }

  console.log(`Cron ${cron} → scanning TFs: ${tfs.join(',')}`);

  const { results: users } = await env.DB.prepare(
    'SELECT id FROM users WHERE active=1 AND expires_at > ?'
  ).bind(Date.now()).all();

  await Promise.allSettled(users.map(u => scanUser(u.id, tfs, env)));
}

async function scanUser(userId, tfs, env) {
  const { results: assets } = await env.DB.prepare(
    'SELECT symbol, timeframes, ebp_alert_mode FROM user_assets WHERE user_id=? AND active=1'
  ).bind(userId).all();

  const tgRow = await env.DB.prepare(
    'SELECT chat_id FROM user_telegram WHERE user_id=? AND verified=1'
  ).bind(userId).first();

  for (const asset of assets) {
    const enabledTfs = (asset.timeframes || '').split(',').filter(Boolean);
    for (const tf of tfs) {
      if (!enabledTfs.includes(tf)) continue;
      try {
        await processAssetTF(userId, asset, tf, tgRow, env);
      } catch (e) {
        console.error(`Error processing ${asset.symbol} ${tf} for ${userId}:`, e.message);
      }
    }
  }
}

async function processAssetTF(userId, asset, tf, tgRow, env) {
  const result = await checkEBP(asset.symbol, tf, env.TWELVE_DATA_KEY, env);
  if (!result) return;

  const { direction, trendBias, htfTf, closure, closePos, candleTime } = result;

  const alertMode = asset.ebp_alert_mode || 'aligned';
  const isAligned = (direction === 'bull' && trendBias === 'bullish') ||
                    (direction === 'bear' && trendBias === 'bearish');

  if (alertMode === 'aligned' && !isAligned) return;

  const alreadyFired = await wasAlertFired(env, userId, asset.symbol, tf, direction, candleTime);
  if (alreadyFired) return;

  await recordAlert(env, userId, asset.symbol, tf, direction, trendBias, candleTime, 'ebp');

  if (tgRow?.chat_id) {
    const text = formatEBPAlert({
      symbol: asset.symbol,
      timeframe: tf,
      direction,
      closure,
      closePos,
      trendBias,
      htfTf,
    });
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, tgRow.chat_id, text).catch(e =>
      console.error('Telegram send failed:', e.message)
    );
  }
}
