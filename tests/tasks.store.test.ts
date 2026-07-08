import { describe, it, expect, beforeEach } from 'vitest'
import { TaskStore } from '../server/src/tasks/store.js'
import type {
  CreateDailyTaskInput,
  CreateDevelopmentalTaskInput,
  CreateRoutineTaskInput,
} from '../server/src/tasks/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_1 = 'user-id-001'
const USER_2 = 'user-id-002'

const sshDaily: CreateDailyTaskInput = {
  type: 'daily',
  userId: USER_1,
  name: 'SSH health check',
  subtype: 'ssh',
  config: { host: 'example.com', username: 'deploy', command: 'uptime' },
  schedule: { type: 'cron', cron: '0 9 * * 1-5' },
}

const httpDaily: CreateDailyTaskInput = {
  type: 'daily',
  userId: USER_1,
  name: 'HTTP ping',
  subtype: 'http',
  config: { url: 'https://example.com/health', method: 'GET' },
}

const devTask: CreateDevelopmentalTaskInput = {
  type: 'developmental',
  userId: USER_1,
  name: 'Auto-refactor',
  repoUrl: 'https://github.com/example/repo',
  agentName: 'claude-code',
  branchName: 'feature/auto-refactor',
}

const routine: CreateRoutineTaskInput = {
  type: 'routine',
  userId: USER_1,
  name: 'Morning routine',
  steps: [{ taskId: 'some-id' }, { taskId: 'other-id', condition: 'previous.status === "succeeded"' }],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskStore — daily task CRUD', () => {
  let store: TaskStore

  beforeEach(() => {
    store = new TaskStore()
  })

  it('creates a daily task with expected defaults', () => {
    const task = store.createDailyTask(sshDaily)
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(task.userId).toBe(USER_1)
    expect(task.type).toBe('daily')
    expect(task.name).toBe('SSH health check')
    expect(task.subtype).toBe('ssh')
    expect(task.status).toBe('idle')
    expect(task.createdAt).toBeTruthy()
    expect(task.updatedAt).toBe(task.createdAt)
    const cfg = task.config as { host: string; username: string; command: string }
    expect(cfg.host).toBe('example.com')
    expect(task.schedule).toEqual({ type: 'cron', cron: '0 9 * * 1-5' })
  })

  it('defaults schedule to manual when omitted', () => {
    const task = store.createDailyTask(httpDaily)
    expect(task.schedule).toEqual({ type: 'manual' })
  })

  it('retrieves a task by id', () => {
    const task = store.createDailyTask(sshDaily)
    const found = store.getTask(task.id)
    expect(found).toEqual(task)
  })

  it('returns undefined for an unknown id', () => {
    expect(store.getTask('nonexistent')).toBeUndefined()
  })

  it('lists created tasks', () => {
    const a = store.createDailyTask(sshDaily)
    const b = store.createDailyTask(httpDaily)
    const list = store.listTasks()
    expect(list).toHaveLength(2)
    expect(list.map((t) => t.id)).toContain(a.id)
    expect(list.map((t) => t.id)).toContain(b.id)
  })

  it('filters list by type', () => {
    store.createDailyTask(sshDaily)
    store.createDevelopmentalTask(devTask)
    const daily = store.listTasks('daily')
    expect(daily).toHaveLength(1)
    expect(daily[0].type).toBe('daily')
    const dev = store.listTasks('developmental')
    expect(dev).toHaveLength(1)
    expect(dev[0].type).toBe('developmental')
  })

  it('filters list by userId', () => {
    const user2Task: CreateDailyTaskInput = { ...sshDaily, userId: USER_2, name: 'User 2 task' }
    store.createDailyTask(sshDaily)
    store.createDailyTask(user2Task)
    const user1Tasks = store.listTasks(undefined, USER_1)
    expect(user1Tasks).toHaveLength(1)
    expect(user1Tasks[0].userId).toBe(USER_1)
    const user2Tasks = store.listTasks(undefined, USER_2)
    expect(user2Tasks).toHaveLength(1)
    expect(user2Tasks[0].userId).toBe(USER_2)
  })

  it('filters by both type and userId', () => {
    const user2Daily: CreateDailyTaskInput = { ...sshDaily, userId: USER_2 }
    store.createDailyTask(sshDaily)
    store.createDailyTask(user2Daily)
    store.createDevelopmentalTask(devTask)
    const result = store.listTasks('daily', USER_1)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('daily')
    expect(result[0].userId).toBe(USER_1)
  })

  it('updates a daily task and bumps updatedAt', async () => {
    const task = store.createDailyTask(sshDaily)
    await new Promise((r) => setTimeout(r, 5)) // ensure time progresses
    const updated = store.updateDailyTask(task.id, { name: 'Renamed' })
    expect(updated).toBeDefined()
    expect(updated!.name).toBe('Renamed')
    expect(updated!.updatedAt).not.toBe(task.updatedAt)
    expect(updated!.id).toBe(task.id)
    expect(updated!.createdAt).toBe(task.createdAt)
  })

  it('updateDailyTask returns undefined for unknown id', () => {
    expect(store.updateDailyTask('missing', { name: 'x' })).toBeUndefined()
  })

  it('updateDailyTask returns undefined for wrong task type', () => {
    const dev = store.createDevelopmentalTask(devTask)
    expect(store.updateDailyTask(dev.id, { name: 'x' })).toBeUndefined()
  })

  it('deletes a task and returns true', () => {
    const task = store.createDailyTask(sshDaily)
    expect(store.deleteTask(task.id)).toBe(true)
    expect(store.getTask(task.id)).toBeUndefined()
    expect(store.listTasks()).toHaveLength(0)
  })

  it('returns false when deleting a non-existent task', () => {
    expect(store.deleteTask('ghost')).toBe(false)
  })

  it('assigns unique ids to each task', () => {
    const a = store.createDailyTask(sshDaily)
    const b = store.createDailyTask(sshDaily)
    expect(a.id).not.toBe(b.id)
  })
})

describe('TaskStore — developmental task', () => {
  let store: TaskStore

  beforeEach(() => {
    store = new TaskStore()
  })

  it('creates a developmental task with provided branchName', () => {
    const task = store.createDevelopmentalTask(devTask)
    expect(task.type).toBe('developmental')
    expect(task.repoUrl).toBe('https://github.com/example/repo')
    expect(task.agentName).toBe('claude-code')
    expect(task.branchName).toBe('feature/auto-refactor')
    expect(task.status).toBe('idle')
  })

  it('generates a branchName when none is provided', () => {
    const task = store.createDevelopmentalTask({
      type: 'developmental',
      userId: USER_1,
      name: 'My task',
      repoUrl: 'https://github.com/example/repo',
      agentName: 'opencode',
    })
    expect(typeof task.branchName).toBe('string')
    expect(task.branchName.length).toBeGreaterThan(0)
  })

  it('updates developmental task fields', () => {
    const task = store.createDevelopmentalTask(devTask)
    const updated = store.updateDevelopmentalTask(task.id, {
      repoUrl: 'https://github.com/example/other',
      agentName: 'omnimancer',
    })
    expect(updated!.repoUrl).toBe('https://github.com/example/other')
    expect(updated!.agentName).toBe('omnimancer')
    // unchanged
    expect(updated!.branchName).toBe('feature/auto-refactor')
  })

  it('updateDevelopmentalTask returns undefined for unknown id', () => {
    expect(store.updateDevelopmentalTask('nope', {})).toBeUndefined()
  })

  it('updateDevelopmentalTask returns undefined for wrong task type', () => {
    const daily = store.createDailyTask(sshDaily)
    expect(store.updateDevelopmentalTask(daily.id, {})).toBeUndefined()
  })
})

describe('TaskStore — routine task', () => {
  let store: TaskStore

  beforeEach(() => {
    store = new TaskStore()
  })

  it('creates a routine task', () => {
    const task = store.createRoutineTask(routine)
    expect(task.type).toBe('routine')
    expect(task.steps).toHaveLength(2)
    expect(task.steps[0].taskId).toBe('some-id')
    expect(task.steps[1].condition).toBe('previous.status === "succeeded"')
  })

  it('updates routine steps', () => {
    const task = store.createRoutineTask(routine)
    const updated = store.updateRoutineTask(task.id, {
      steps: [{ taskId: 'new-id' }],
    })
    expect(updated!.steps).toHaveLength(1)
    expect(updated!.steps[0].taskId).toBe('new-id')
  })

  it('updateRoutineTask returns undefined for wrong type', () => {
    const daily = store.createDailyTask(sshDaily)
    expect(store.updateRoutineTask(daily.id, {})).toBeUndefined()
  })
})

describe('TaskStore — status management', () => {
  let store: TaskStore

  beforeEach(() => {
    store = new TaskStore()
  })

  it('updateTaskStatus transitions the status field', () => {
    const task = store.createDailyTask(sshDaily)
    const updated = store.updateTaskStatus(task.id, 'queued')
    expect(updated!.status).toBe('queued')
    // Original object is not mutated
    expect(store.getTask(task.id)!.status).toBe('queued')
  })

  it('updateTaskStatus returns undefined for unknown id', () => {
    expect(store.updateTaskStatus('ghost', 'running')).toBeUndefined()
  })
})

describe('TaskStore — run management', () => {
  let store: TaskStore

  beforeEach(() => {
    store = new TaskStore()
  })

  it('creates a run with queued status', () => {
    const task = store.createDailyTask(sshDaily)
    const run = store.createRun(task.id)
    expect(run).toBeDefined()
    expect(run!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(run!.taskId).toBe(task.id)
    expect(run!.status).toBe('queued')
    expect(run!.logs).toHaveLength(0)
    expect(run!.completedAt).toBeUndefined()
  })

  it('returns undefined when creating a run for a non-existent task', () => {
    expect(store.createRun('ghost')).toBeUndefined()
  })

  it('retrieves a run by id', () => {
    const task = store.createDailyTask(sshDaily)
    const run = store.createRun(task.id)!
    expect(store.getRun(run.id)).toEqual(run)
  })

  it('returns undefined for an unknown run id', () => {
    expect(store.getRun('ghost')).toBeUndefined()
  })

  it('lists runs for a task in creation order', () => {
    const task = store.createDailyTask(sshDaily)
    const r1 = store.createRun(task.id)!
    const r2 = store.createRun(task.id)!
    const runs = store.listRunsForTask(task.id)
    expect(runs).toHaveLength(2)
    expect(runs[0].id).toBe(r1.id)
    expect(runs[1].id).toBe(r2.id)
  })

  it('listRunsForTask returns empty array for a task with no runs', () => {
    const task = store.createDailyTask(sshDaily)
    expect(store.listRunsForTask(task.id)).toHaveLength(0)
  })

  it('listRunsForTask returns empty array for unknown task id', () => {
    expect(store.listRunsForTask('ghost')).toHaveLength(0)
  })

  it('updates run status and completedAt', () => {
    const task = store.createDailyTask(sshDaily)
    const run = store.createRun(task.id)!
    const now = new Date().toISOString()
    const updated = store.updateRun(run.id, {
      status: 'succeeded',
      completedAt: now,
    })
    expect(updated!.status).toBe('succeeded')
    expect(updated!.completedAt).toBe(now)
  })

  it('updateRun returns undefined for unknown run id', () => {
    expect(store.updateRun('ghost', { status: 'failed' })).toBeUndefined()
  })

  it('appends log entries', () => {
    const task = store.createDailyTask(sshDaily)
    const run = store.createRun(task.id)!
    const entry = { timestamp: new Date().toISOString(), message: 'hello', level: 'info' as const }
    const updated = store.appendRunLog(run.id, entry)
    expect(updated!.logs).toHaveLength(1)
    expect(updated!.logs[0]).toEqual(entry)
  })

  it('appendRunLog returns undefined for unknown run id', () => {
    const entry = { timestamp: new Date().toISOString(), message: 'x', level: 'info' as const }
    expect(store.appendRunLog('ghost', entry)).toBeUndefined()
  })

  it('cascades run deletion when task is deleted', () => {
    const task = store.createDailyTask(sshDaily)
    const run = store.createRun(task.id)!
    store.deleteTask(task.id)
    expect(store.getRun(run.id)).toBeUndefined()
    expect(store.listRunsForTask(task.id)).toHaveLength(0)
  })

  it('keeps independent run sets per task', () => {
    const t1 = store.createDailyTask(sshDaily)
    const t2 = store.createDailyTask(httpDaily)
    const r1 = store.createRun(t1.id)!
    const r2 = store.createRun(t2.id)!
    expect(store.listRunsForTask(t1.id).map((r) => r.id)).toContain(r1.id)
    expect(store.listRunsForTask(t1.id).map((r) => r.id)).not.toContain(r2.id)
    expect(store.listRunsForTask(t2.id).map((r) => r.id)).toContain(r2.id)
  })
})
