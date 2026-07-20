import { Hono } from 'hono'
import { cors } from 'hono/cors'
import userRoutes from './routes/user.js'
import alertRoutes from './routes/alerts.js'
import dashboardRoutes from './routes/dashboard.js'
import telegramRoutes from './routes/telegram.js'
import paymentRoutes from './routes/payment.js'
import adminRoutes from './routes/admin.js'
import { handleCron } from './cron.js'

const app = new Hono()

app.use('*', cors({
  origin: ['http://localhost:5173', 'https://ebp-tracker.pages.dev'],
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}))

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.route('/user', userRoutes)
app.route('/alerts', alertRoutes)
app.route('/dashboard', dashboardRoutes)
app.route('/telegram', telegramRoutes)
app.route('/payment', paymentRoutes)
app.route('/admin', adminRoutes)

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event.cron, env))
  },
}
