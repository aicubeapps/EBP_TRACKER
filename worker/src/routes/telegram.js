import { Hono } from 'hono'

const telegram = new Hono()

telegram.post('/link', (c) => c.json({ message: 'not implemented', route: '/telegram/link' }))
telegram.post('/test', (c) => c.json({ message: 'not implemented', route: '/telegram/test' }))
telegram.post('/unlink', (c) => c.json({ message: 'not implemented', route: '/telegram/unlink' }))
telegram.post('/webhook', (c) => c.json({ message: 'not implemented', route: '/telegram/webhook' }))

export default telegram
