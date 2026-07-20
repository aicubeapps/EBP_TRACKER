import { Hono } from 'hono'

const dashboard = new Hono()

dashboard.get('/', (c) => c.json({ message: 'not implemented', route: '/dashboard' }))

export default dashboard
