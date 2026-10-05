// API server entry point. With embedded Postgres (no DATABASE_URL) or
// ROUTINI_INLINE_WORKER=1, the scheduler and queue worker run in this process.

import { bootstrap, startBackground, type Background } from './bootstrap.js'
import { createApp } from './app.js'
import { attachTerminal } from './http/terminal.js'
import { attachHostTerminal } from './http/hostTerminal.js'
import type { Auth } from './http/auth.js'

const ctx = await bootstrap()
const app = createApp(ctx)
const background: Background | null = ctx.config.inlineWorker ? await startBackground(ctx) : null

const server = app.listen(ctx.config.port, () => {
  const store = ctx.config.databaseUrl ? 'Postgres' : `embedded Postgres (${ctx.config.dataDir})`
  const worker = background ? 'inline worker' : 'no worker (run dist/worker.js)'
  console.log(`Routini API on http://localhost:${ctx.config.port} · ${store} · ${ctx.config.mode} · ${worker}`)
})
const terminals = attachTerminal(server, ctx, app.locals['auth'] as Auth)
const hostTerminals = attachHostTerminal(server, ctx, app.locals['auth'] as Auth)
ctx.runners.attach(server)
await ctx.runners.start()

const shutdown = (signal: string) => {
  console.log(`[server] ${signal}: shutting down`)
  setTimeout(() => process.exit(1), 15_000).unref()
  for (const ws of terminals.clients) ws.close(1001, 'server shutting down')
  for (const ws of hostTerminals.clients) ws.close(1001, 'server shutting down')
  void ctx.runners.stop()
  server.close(() => {
    void (async () => {
      await background?.stop()
      await ctx.hub.stop()
      await ctx.db.close()
      process.exit(0)
    })()
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
