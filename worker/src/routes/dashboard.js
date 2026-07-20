import { Hono } from 'hono';
import { clerkAuth } from '../auth.js';

const dashboard = new Hono();

dashboard.use('*', clerkAuth);

dashboard.get('/', async (c) => {
  const userId = c.get('userId');

  const { results: assets } = await c.env.DB.prepare(
    'SELECT id, symbol, display_name, asset_type, timeframes FROM user_assets WHERE user_id=? AND active=1'
  ).bind(userId).all();

  const tfs = ['W', 'D', '4H', '1H', 'M15'];
  const status = {};

  for (const asset of assets) {
    const enabledTfs = (asset.timeframes || '').split(',').filter(Boolean);
    const tfStatus = {};

    for (const tf of tfs) {
      if (!enabledTfs.includes(tf)) { tfStatus[tf] = null; continue; }

      const cached = await c.env.DB.prepare(`
        SELECT bar_0_close, bar_1_open, bar_1_close, bar_1_high, bar_1_low,
               bar_2_high, bar_2_low, updated_at
        FROM candle_cache WHERE symbol=? AND timeframe=?
      `).bind(asset.symbol, tf).first();

      if (!cached) { tfStatus[tf] = null; continue; }

      const b0Close   = cached.bar_0_close;
      const b1Open    = cached.bar_1_open;
      const b1Close   = cached.bar_1_close;
      const prevBodyH = Math.max(b1Open, b1Close);
      const prevBodyL = Math.min(b1Open, b1Close);

      const { results: recentAlerts } = await c.env.DB.prepare(`
        SELECT direction FROM alert_history
        WHERE user_id=? AND symbol=? AND timeframe=?
        ORDER BY fired_at DESC LIMIT 1
      `).bind(userId, asset.symbol, tf).all();

      tfStatus[tf] = recentAlerts[0]?.direction ?? null;
    }

    status[asset.symbol] = {
      id: asset.id,
      symbol: asset.symbol,
      displayName: asset.display_name,
      assetType: asset.asset_type,
      tfStatus,
    };
  }

  const { results: recentAlerts } = await c.env.DB.prepare(`
    SELECT ah.symbol, ah.timeframe, ah.direction, ah.fired_at
    FROM alert_history ah
    WHERE ah.user_id=?
    ORDER BY ah.fired_at DESC LIMIT 10
  `).bind(userId).all();

  return c.json({ assets: Object.values(status), recentAlerts });
});

export default dashboard;
