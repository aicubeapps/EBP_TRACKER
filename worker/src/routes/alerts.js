import { Hono } from 'hono'

const alerts = new Hono()

alerts.get('/history', (c) => c.json({ message: 'not implemented', route: '/alerts/history' }))

export default alerts
