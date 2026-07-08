import { createApp } from './app.js'
import { loadAuthConfig, UserStore } from './auth/index.js'
import { loadConfig } from './config.js'

const config = loadConfig()

// Auth: build shared dependencies once and reuse them across routers.
const authConfig = loadAuthConfig()
const users = new UserStore(
  authConfig.userStorePath ? { filePath: authConfig.userStorePath } : undefined,
)

/**
 * Bootstrap the user store: load any persisted state, then seed the default
 * admin only if the store is otherwise empty. We surface a hard failure via
 * `process.exitCode` so ops sees the crash and doesn't run with an unusable
 * auth state.
 */
async function bootstrapAuth(): Promise<void> {
  try {
    await users.load()
  } catch (err) {
    console.error('failed to load user store', {
      name: (err as Error).name,
      message: (err as Error).message,
    })
    process.exitCode = 1
    return
  }
  if (users.size() > 0) return
  try {
    await users.createUser(authConfig.defaultUsername, authConfig.defaultPassword)
  } catch (err) {
    console.error('failed to seed default admin user', {
      name: (err as Error).name,
      message: (err as Error).message,
    })
    process.exitCode = 1
  }
}

const authDeps = { config: authConfig, users }
const authReady = bootstrapAuth()
const app = createApp({ config, authDeps })

// Start the server unless this module is being imported by tests.
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  authReady.then(() => {
    app.listen(config.port, () => {
      console.log(`Server running on http://localhost:${config.port}`)
    })
  })
}

export { app, authDeps, authReady }
