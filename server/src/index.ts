// API server entry point.

import { bootstrap } from './bootstrap.js'
import { createApp } from './app.js'

const ctx = await bootstrap()
const app = createApp(ctx)
const server = app.listen(ctx.config.port, () => {
  const store = ctx.config.databaseUrl ? 'Postgres' : `embedded Postgres (${ctx.config.dataDir})`
  console.log(`Routini API on http://localhost:${ctx.config.port} · ${store} · ${ctx.config.mode}`)
})

const shutdown = (signal: string) => {
  console.log(`[server] ${signal}: shutting down`)
  server.close(() => {
    ctx.db.close().finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
