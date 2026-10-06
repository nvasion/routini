// Standalone worker process (scheduler + queue). Needs DATABASE_URL: embedded
// Postgres cannot be shared between processes, so there the API runs the worker inline.

import { bootstrap, startBackground } from './bootstrap.js'
import { loadConfig } from './config.js'

const config = loadConfig()
if (!config.databaseUrl) {
  console.error('[worker] DATABASE_URL is required; without it the API process runs the worker itself.')
  process.exit(1)
}

const ctx = await bootstrap(config)
const background = await startBackground(ctx)

const shutdown = (signal: string) => {
  console.log(`[worker] ${signal}: draining`)
  setTimeout(() => process.exit(1), 60_000).unref()
  void (async () => {
    await background.stop()
    await ctx.db.close()
    process.exit(0)
  })()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
