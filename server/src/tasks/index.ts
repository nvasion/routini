/**
 * Public entry point for the tasks module.
 *
 * Import from here rather than from individual files so the module internals
 * can be reorganised without changing consumer import paths.
 */

export { TaskStore } from './store.js'
export type { UpdateTaskResult, TaskStoreOptions } from './store.js'
export { createTasksRouter, createRunsRouter } from './routes.js'
export type { TaskRouterOptions } from './routes.js'
export { createTaskEventsRouter } from './sse.js'
export type { SseRouterOptions } from './sse.js'
export {
  TaskRunEventBus,
  InProcessTaskRunEventBus,
  defaultRunBus,
} from './events.js'
export type {
  TaskRunEvent,
  TaskEventPublisher,
  TaskEventSubscriber,
  TaskRunEventTransport,
} from './events.js'
export type { WireEvent } from './wireEvents.js'
export {
  defaultExecutor,
  launchExecution,
  createDispatchExecutor,
} from './executor.js'
export type {
  TaskExecutor,
  LaunchOptions,
  ExecutorMap,
} from './executor.js'
export { createDailyExecutor } from './daily/executor.js'
export type { DailyHandlers, DailyExecutorOptions } from './daily/executor.js'
export { runSsh } from './daily/sshHandler.js'
export type { SshRunResult, SshRunOptions } from './daily/sshHandler.js'
export { checkEmail } from './daily/emailHandler.js'
export type {
  EmailCheckResult,
  EmailCheckOptions,
  TlsLikeSocket,
} from './daily/emailHandler.js'
export { fetchDashboard } from './daily/dashboardHandler.js'
export type {
  DashboardFetchResult,
  DashboardFetchOptions,
} from './daily/dashboardHandler.js'
export {
  resolveHostnameSafe,
  UnsafeHostError,
  defaultLookup,
} from './daily/dns.js'
export type { SafeAddress, LookupFn } from './daily/dns.js'
export {
  sanitizeError,
  redactCredentials,
  redactCommonSecrets,
  REDACTED,
} from './daily/sanitizeError.js'
export type { SanitizeErrorOptions } from './daily/sanitizeError.js'
export {
  createDockerExecutor,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_DOCKER_LIMITS,
  DockerExecutionError,
  defaultRunOptionsFromTask,
  readDockerLimitsFromEnv,
  resolveDockerConnection,
  validateImageName,
  validateDockerNetworkName,
} from './docker.js'
export type {
  DockerClient,
  DockerContainer,
  DockerContainerCreateOptions,
  DockerErrorCode,
  DockerExecutorConfig,
  DockerHostConfig,
  DockerMount,
  DockerResourceLimits,
  DockerRunOptions,
  SecretMount,
} from './docker.js'
export {
  createDevelopmentalExecutor,
  buildDevelopmentalRunOptions,
} from './developmental/service.js'
export type { DevelopmentalExecutorConfig } from './developmental/service.js'
export {
  validateCreateTask,
  validateUpdateTask,
  validateUrl,
  validateCron,
  validateBranchName,
  isSsrfUnsafeHostname,
  VALID_AGENTS,
  VALID_SUBTYPES,
  VALID_HTTP_METHODS,
} from './validation.js'
export { VALID_TASK_TYPES } from './types.js'
export { createRoutineExecutor, RoutineStepError } from './routine/executor.js'
export { evaluateCondition, isValidConditionSyntax } from './routine/condition.js'
export type { StepContext } from './routine/condition.js'
export type {
  Task,
  DailyTask,
  DevelopmentalTask,
  RoutineTask,
  TaskRun,
  LogEntry,
  TaskType,
  TaskStatus,
  RunStatus,
  DailySubtype,
  AgentName,
  HttpMethod,
  ScheduleType,
  ScheduleConfig,
  SshConfig,
  EmailConfig,
  HttpConfig,
  RoutineStep,
  CreateTaskInput,
  CreateDailyTaskInput,
  CreateDevelopmentalTaskInput,
  CreateRoutineTaskInput,
  UpdateDailyTaskInput,
  UpdateDevelopmentalTaskInput,
  UpdateRoutineTaskInput,
} from './types.js'
