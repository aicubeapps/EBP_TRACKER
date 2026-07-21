/**
 * Sweep detection + pending-signal bookkeeping for the sweep-detector worker.
 *
 * A "sweep" is a liquidity grab: price pokes beyond the prior candle's
 * high/low, then closes back inside that level.
 */

/**
 * Detect a liquidity sweep on the two most-recent candles.
 *
 * @param {Array} candles - newest-first [bar0 (latest closed), bar1, ...]
 *   Bull: bar0.low  < bar1.low  AND bar0.close > bar1.low
 *   Bear: bar0.high > bar1.high AND bar0.close < bar1.high
 * @returns {{ direction, candleTime, sweptLevel, closedInsideLevel } | null}
 */
export function detectSweep(candles) {
  if (!candles || candles.length < 2) return null;

  const [bar0, bar1] = candles;

  if (bar0.low < bar1.low && bar0.close > bar1.low) {
    return {
      direction: 'bull',
      candleTime: bar0.time,
      sweptLevel: bar1.low,
      closedInsideLevel: bar0.close > bar1.low,
    };
  }

  if (bar0.high > bar1.high && bar0.close < bar1.high) {
    return {
      direction: 'bear',
      candleTime: bar0.time,
      sweptLevel: bar1.high,
      closedInsideLevel: bar0.close < bar1.high,
    };
  }

  return null;
}

/**
 * Upsert the latest candles + sweep status for a symbol/timeframe into
 * the sweep_candle_cache table (one row per symbol+timeframe).
 */
export async function updateSweepCandleCache(db, symbol, tf, candles) {
  if (!candles || candles.length < 2) return;

  const [b0, b1, b2] = candles;
  const sweep = detectSweep(candles);

  try {
    await db.prepare(`
      INSERT INTO sweep_candle_cache
        (symbol, timeframe,
         bar_0_open, bar_0_high, bar_0_low, bar_0_close,
         bar_1_open, bar_1_high, bar_1_low, bar_1_close,
         bar_2_open, bar_2_high, bar_2_low, bar_2_close,
         bar_0_time, bar_1_time,
         sweep_direction, swept_level, closed_inside, candle_time,
         updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(symbol, timeframe) DO UPDATE SET
        bar_0_open=excluded.bar_0_open, bar_0_high=excluded.bar_0_high,
        bar_0_low=excluded.bar_0_low,   bar_0_close=excluded.bar_0_close,
        bar_1_open=excluded.bar_1_open, bar_1_high=excluded.bar_1_high,
        bar_1_low=excluded.bar_1_low,   bar_1_close=excluded.bar_1_close,
        bar_2_open=excluded.bar_2_open, bar_2_high=excluded.bar_2_high,
        bar_2_low=excluded.bar_2_low,   bar_2_close=excluded.bar_2_close,
        bar_0_time=excluded.bar_0_time, bar_1_time=excluded.bar_1_time,
        sweep_direction=excluded.sweep_direction,
        swept_level=excluded.swept_level,
        closed_inside=excluded.closed_inside,
        candle_time=excluded.candle_time,
        updated_at=excluded.updated_at
    `).bind(
      symbol, tf,
      b0.open, b0.high, b0.low, b0.close,
      b1?.open, b1?.high, b1?.low, b1?.close,
      b2?.open, b2?.high, b2?.low, b2?.close,
      b0.time, b1?.time,
      sweep?.direction ?? null,
      sweep?.sweptLevel ?? null,
      sweep ? (sweep.closedInsideLevel ? 1 : 0) : null,
      sweep?.candleTime ?? null,
      Date.now()
    ).run();
  } catch (e) {
    console.warn('sweep_candle_cache write failed:', e.message);
  }
}

/**
 * Find pending signals that pair with a fresh sweep on `ltfTF`.
 *
 * Looks up the user's combined_pairs config for this symbol, then for each
 * live (non-expired) pending signal checks whether it forms a configured
 * pair with the current lower-timeframe sweep and has not been consumed yet.
 *
 * @returns {Array<{ signal, pairKey }>}
 */
export async function checkPendingSignals(db, userId, symbol, direction, ltfTF) {
  const asset = await db.prepare(
    'SELECT combined_pairs FROM user_assets WHERE user_id=? AND symbol=? AND active=1'
  ).bind(userId, symbol).first();
  if (!asset) return [];

  let pairs;
  try {
    pairs = JSON.parse(asset.combined_pairs || '[]');
  } catch {
    pairs = [];
  }
  if (!Array.isArray(pairs) || pairs.length === 0) return [];

  // Normalize each configured pair to a { htf, ltf } shape.
  const normPairs = pairs.map((p) => {
    if (typeof p === 'string') {
      const [htf, ltf] = p.split('+');
      return { htf, ltf };
    }
    return { htf: p.htf ?? p.a, ltf: p.ltf ?? p.b };
  }).filter((p) => p.htf && p.ltf);

  const { results: signals } = await db.prepare(`
    SELECT * FROM pending_signals
    WHERE user_id=? AND symbol=? AND direction=? AND expires_at > ?
  `).bind(userId, symbol, direction, Date.now()).all();

  const matches = [];
  for (const signal of signals || []) {
    let consumed;
    try {
      consumed = JSON.parse(signal.consumed_pairs || '[]');
    } catch {
      consumed = [];
    }

    for (const pair of normPairs) {
      // The pending signal must be the HTF leg, the fresh sweep the LTF leg.
      if (pair.htf !== signal.timeframe || pair.ltf !== ltfTF) continue;

      const pairKey = `${pair.htf}+${pair.ltf}`;
      if (consumed.includes(pairKey)) continue;

      matches.push({ signal, pairKey });
    }
  }

  return matches;
}

/**
 * Mark a pair as consumed on a pending signal so it won't re-fire.
 */
export async function consumePendingSignal(db, signalId, pairKey) {
  const row = await db.prepare(
    'SELECT consumed_pairs FROM pending_signals WHERE id=?'
  ).bind(signalId).first();
  if (!row) return;

  let consumed;
  try {
    consumed = JSON.parse(row.consumed_pairs || '[]');
  } catch {
    consumed = [];
  }
  if (consumed.includes(pairKey)) return;

  consumed.push(pairKey);
  await db.prepare(
    'UPDATE pending_signals SET consumed_pairs=? WHERE id=?'
  ).bind(JSON.stringify(consumed), signalId).run();
}

/**
 * Purge pending signals whose window has elapsed.
 */
export async function cleanupExpiredSignals(db) {
  await db.prepare(
    'DELETE FROM pending_signals WHERE expires_at < ?'
  ).bind(Date.now()).run();
}
