import { Hono } from 'hono';
import { clerkAuth } from '../auth.js';
import { sendTelegramMessage } from '../../../packages/core/telegram.js';

const telegram = new Hono();

// Public — called by Telegram servers, no auth
telegram.post('/webhook', async (c) => {
  try {
    const body    = await c.req.json().catch(() => null);
    const message = body?.message;
    if (!message) return c.json({ ok: true });

    const chatId = message.chat?.id?.toString();
    const text   = (message.text ?? '').trim();

    if (text === '/start' || text.startsWith('/start ')) {
      await sendTelegramMessage(c.env.TELEGRAM_BOT_TOKEN, chatId,
        '👋 <b>Welcome to EBP Tracker Bot!</b>\n\n' +
        'To connect your account:\n' +
        '1. Go to your EBP Tracker dashboard\n' +
        '2. Open Settings → Telegram\n' +
        '3. Click "Get Connection Code"\n' +
        '4. Send the 4-digit code here\n\n' +
        'Waiting for your code...'
      );
      return c.json({ ok: true });
    }

    if (/^\d{4}$/.test(text)) {
      const record = await c.env.DB.prepare(
        'SELECT user_id FROM user_telegram WHERE link_code = ?'
      ).bind(text).first();

      if (!record) {
        await sendTelegramMessage(c.env.TELEGRAM_BOT_TOKEN, chatId,
          '❌ Invalid or expired code. Please get a new code from the dashboard Settings page.'
        );
        return c.json({ ok: true });
      }

      await c.env.DB.prepare(
        'UPDATE user_telegram SET chat_id = ?, verified = 1, link_code = NULL, updated_at = ? WHERE user_id = ?'
      ).bind(chatId, Date.now(), record.user_id).run();

      await sendTelegramMessage(c.env.TELEGRAM_BOT_TOKEN, chatId,
        '✅ <b>EBP Tracker connected!</b>\n\n' +
        'You will now receive alerts here.\n\n' +
        'Go back to the dashboard to configure your assets and alert preferences.'
      );
      return c.json({ ok: true });
    }

    await sendTelegramMessage(c.env.TELEGRAM_BOT_TOKEN, chatId,
      '🤖 Send your 4-digit connection code to link your account.\n\n' +
      'Get the code from Settings → Telegram on the EBP Tracker dashboard.'
    );
    return c.json({ ok: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return c.json({ ok: true }); // always 200 to Telegram
  }
});

// Authenticated routes below

telegram.post('/initlink', clerkAuth, async (c) => {
  const userId = c.get('userId');
  const code   = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit
  await c.env.DB.prepare(`
    INSERT INTO user_telegram (user_id, chat_id, link_code, verified, updated_at)
    VALUES (?, '', ?, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET link_code=excluded.link_code, verified=0, updated_at=excluded.updated_at
  `).bind(userId, code, Date.now()).run();
  return c.json({ code });
});

telegram.get('/', clerkAuth, async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    'SELECT verified, chat_id FROM user_telegram WHERE user_id = ?'
  ).bind(userId).first();
  if (!row) return c.json({ connected: false });
  return c.json({
    connected: row.verified === 1,
    chatIdMasked: row.chat_id ? `••••${String(row.chat_id).slice(-4)}` : null,
  });
});

telegram.post('/verify', clerkAuth, async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    'SELECT verified, chat_id FROM user_telegram WHERE user_id = ?'
  ).bind(userId).first();
  if (!row) return c.json({ verified: false });
  return c.json({
    verified: row.verified === 1,
    chatIdMasked: row.chat_id ? `••••${String(row.chat_id).slice(-4)}` : null,
  });
});

telegram.post('/test', clerkAuth, async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    'SELECT chat_id, verified FROM user_telegram WHERE user_id = ?'
  ).bind(userId).first();
  if (!row?.verified) return c.json({ error: 'Telegram not connected' }, 400);
  await sendTelegramMessage(
    c.env.TELEGRAM_BOT_TOKEN, row.chat_id,
    '✅ <b>Test alert from EBP Tracker</b>\n\nYour Telegram alerts are working correctly.'
  );
  return c.json({ ok: true });
});

telegram.delete('/', clerkAuth, async (c) => {
  const userId = c.get('userId');
  await c.env.DB.prepare(
    "UPDATE user_telegram SET verified = 0, chat_id = '', updated_at = ? WHERE user_id = ?"
  ).bind(Date.now(), userId).run();
  return c.json({ ok: true });
});

export default telegram;
