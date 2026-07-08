/**
 * Public entry point for the tasks module.
 *
 * Import from here rather than from individual files so the module internals
 * can be reorganised without changing consumer import paths.
 */

export { TaskStore } from './store.js'
export type { UpdateTaskResult } from './store.js'
export { createTasksRouter, createRunsRouter } from './routes.js'
export type { TaskRouterOptions } from './routes.js'
export { defaultExecutor, launchExecution } from './executor.js'
export type { TaskExecutor } from './executor.js'
export {
  createDockerExecutor,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_DOCKER_LIMITS,
  DockerExecutionError,
  defaultRunOptionsFromTask,
  readDockerLimitsFromEnv,
  resolveDockerConnection,
  validateImageName,
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
