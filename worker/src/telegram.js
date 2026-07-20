// Telegram bot dispatcher stub

export async function sendAlert(chatId, message, env) {
  // Stub: POST to Telegram Bot API
  const url = `https://api.telegram.org/bot${env.SHARED_BOT_TOKEN}/sendMessage`
  // await fetch(url, { method: 'POST', body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }) })
  console.log(`[Telegram stub] → ${chatId}: ${message}`)
}

export async function handleBotWebhook(update, env) {
  // Stub: process incoming Telegram bot updates
}
