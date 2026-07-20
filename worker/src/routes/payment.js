import { Hono } from 'hono'

const payment = new Hono()

payment.post('/submit', (c) => c.json({ message: 'not implemented', route: '/payment/submit' }))
payment.get('/status', (c) => c.json({ message: 'not implemented', route: '/payment/status' }))

export default payment
