import { Hono } from 'hono';
import { clerkAuth } from '../auth.js';
import { sendTelegramMessage } from '../../../packages/core/telegram.js';

const telegram = new Hono();

telegram.post('/link', clerkAuth, async (c) => {
  const userId = c.get('userId');
  const { chat_id } = await c.req.json();
  if (!chat_id) return c.json({ error: 'chat_id required' }, 400);

  const linkCode = Math.random().toString(36).slice(2, 8).toUpperCase();
  await c.env.DB.prepare(`
    INSERT INTO user_telegram (user_id, chat_id, link_code, verified, updated_at)
    VALUES (?,?,?,0,?)
    ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id, link_code=excluded.link_code, verified=0, updated_at=excluded.updated_at
  `).bind(userId, String(chat_id), linkCode, Date.now()).run();

  try {
    await sendTelegramMessage(
      c.env.TELEGRAM_BOT_TOKEN, String(chat_id),
      `🔗 <b>EBP Tracker Linked!</b>\n\nYour account is now connected. You will receive trading alerts here.\n\nVerification code: <code>${linkCode}</code>`
    );
    await c.env.DB.prepare('UPDATE user_telegram SET verified=1 WHERE user_id=?').bind(userId).run();
  } catch (e) {
    return c.json({ error: `Could not send test message: ${e.message}` }, 422);
  }

  return c.json({ ok: true, verified: true });
});

telegram.post('/test', clerkAuth, async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare('SELECT chat_id, verified FROM user_telegram WHERE user_id=?').bind(userId).first();
  if (!row?.verified) return c.json({ error: 'Telegram not linked' }, 400);

  await sendTelegramMessage(
    c.env.TELEGRAM_BOT_TOKEN, row.chat_id,
    '✅ <b>Test alert from EBP Tracker</b>\n\nYour Telegram alerts are working correctly.'
  );
  return c.json({ ok: true });
});

telegram.post('/unlink', clerkAuth, async (c) => {
  const userId = c.get('userId');
  await c.env.DB.prepare('DELETE FROM user_telegram WHERE user_id=?').bind(userId).run();
  return c.json({ ok: true });
});

telegram.post('/webhook', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.message?.text) return c.json({ ok: true });

  const text   = body.message.text.trim();
  const chatId = String(body.message.chat.id);

  if (text.startsWith('/start')) {
    const token = text.split(' ')[1];
    if (token) {
      const row = await c.env.DB.prepare(
        'SELECT user_id FROM user_telegram WHERE link_code=? AND verified=0'
      ).bind(token).first();
      if (row) {
        await c.env.DB.prepare(
          'UPDATE user_telegram SET chat_id=?, verified=1, updated_at=? WHERE user_id=?'
        ).bind(chatId, Date.now(), row.user_id).run();
        await sendTelegramMessage(c.env.TELEGRAM_BOT_TOKEN, chatId, '✅ <b>EBP Tracker linked!</b> You will now receive alerts here.');
      }
    }
  }

  return c.json({ ok: true });
});

export default telegram;
