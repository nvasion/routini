import Docker from 'dockerode'
import { createApp } from './app.js'
import { loadAuthConfig, UserStore } from './auth/index.js'
import { loadConfig } from './config.js'
import {
  createNotifier,
  loadNotificationConfig,
  validateNotificationConfig,
} from './notifications/index.js'
import {
  AiSettingsStore,
  resolveAiEncryptor,
} from './aiSettings/index.js'
import {
  createDailyExecutor,
  createDevelopmentalExecutor,
  createDispatchExecutor,
  createRoutineExecutor,
  readDockerLimitsFromEnv,
  resolveDockerConnection,
  DockerExecutionError,
  redactCommonSecrets,
} from './tasks/index.js'
import type { TaskExecutor } from './tasks/index.js'

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

// Notification service — enabled when NOTIFY_PROVIDER env var is set.
const notificationConfig = loadNotificationConfig()
const notificationErrors = validateNotificationConfig(notificationConfig)
if (notificationErrors.length > 0) {
  console.error('Notification config errors (notifications disabled):', notificationErrors)
}
const notifier =
  notificationErrors.length === 0 ? createNotifier(notificationConfig) : undefined
if (notifier) {
  console.log(`[notifications] email notifications enabled via ${notificationConfig.provider}`)
}

// AI settings — shared store so all routers see the same per-user settings.
const aiSettingsStore = new AiSettingsStore({ encryptor: resolveAiEncryptor() })

/**
 * Attempt to build a dispatch executor that routes task types to their
 * concrete handlers. Developmental tasks use the Docker-backed executor when
 * a Docker daemon connection is configured; all task types fall back to the
 * default (no-op) executor when not wired.
 *
 * Docker connection is fail-secure: if no daemon connection env var is set
 * (DOCKER_HOST, DOCKER_SOCKET_PATH, DOCKER_ALLOW_DEFAULT_SOCKET) the Docker
 * executor is silently disabled and developmental tasks use the stub. This
 * prevents an accidental startup failure just because Docker isn't available
 * in all environments (e.g. local dev without Docker).
 *
 * Production deployments MUST set DOCKER_HOST (or the other env vars) to
 * enable the real developmental task executor.
 */
function buildExecutor(): TaskExecutor | undefined {
  // Daily executor handles SSH, email, and HTTP tasks.
  const dailyExecutor = createDailyExecutor()

  // Developmental executor: requires a Docker daemon connection.
  let developmentalExecutor: TaskExecutor | undefined
  try {
    const dockerConn = resolveDockerConnection(process.env as Record<string, string | undefined>)
    const dockerClient = new Docker(dockerConn)
    developmentalExecutor = createDevelopmentalExecutor({
      client: dockerClient,
      aiSettings: aiSettingsStore,
      limits: readDockerLimitsFromEnv(process.env as Record<string, string | undefined>),
    })
    console.log('[tasks] Docker developmental executor enabled')
  } catch (err) {
    if (err instanceof DockerExecutionError && err.code === 'INSECURE_CONNECTION') {
      // No Docker daemon configured — not an error in dev environments.
      console.warn(
        '[tasks] Docker not configured — developmental tasks will use the stub executor. ' +
          'Set DOCKER_HOST or DOCKER_ALLOW_DEFAULT_SOCKET=1 to enable the real executor.',
      )
    } else {
      // Any other error (invalid limits, bad DOCKER_HOST, bad network name, …)
      // is a fatal misconfiguration. Sanitize the message before logging so we
      // never inadvertently echo credential material that may appear in error
      // strings from the Docker SDK or the encryptor. Mark the process as
      // unhealthy so the container orchestrator restarts it.
      const rawMsg = err instanceof Error ? err.message : String(err)
      const safeMsg = redactCommonSecrets(rawMsg)
      console.error('[tasks] Fatal: failed to initialise Docker executor:', safeMsg)
      process.exitCode = 1
    }
  }

  // Build the sub-executor for step execution inside routines.
  // It deliberately omits the routine handler to prevent nested routines
  // (the step-lookup guard is a defence-in-depth check; this makes infinite
  // recursion structurally impossible even if that guard were bypassed).
  const subExecutor = createDispatchExecutor({
    daily: dailyExecutor,
    developmental: developmentalExecutor,
  })

  const routineExecutor = createRoutineExecutor(subExecutor)

  return createDispatchExecutor({
    daily: dailyExecutor,
    developmental: developmentalExecutor,
    routine: routineExecutor,
  })
}

const executor = buildExecutor()
const authDeps = { config: authConfig, users }
const authReady = bootstrapAuth()
const app = createApp({
  config,
  authDeps,
  notifier,
  notifierOptions: { defaultToEmail: notificationConfig.defaultToEmail },
  executor,
  aiSettings: aiSettingsStore,
})

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
