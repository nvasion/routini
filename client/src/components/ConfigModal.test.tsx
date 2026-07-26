import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigModal } from './ConfigModal'
import type { DailyTask, DevTask, Routine } from '../types'

// ConfigModal replaced the read-only TaskConfigPanel side-drawer with a
// centered, *editable* modal that persists changes via PUT /api/tasks/:id.
// These tests focus on the editable-save behavior (the headline change from
// TaskConfigPanel) plus the modal's close affordances, across all three task
// types.

vi.mock('../api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../api'

const mockedApiFetch = vi.mocked(apiFetch)

function makeDailyTask(overrides: Partial<DailyTask> = {}): DailyTask {
  return {
    id: 'daily-1',
    name: 'Morning sync',
    description: 'Runs every morning',
    type: 'daily',
    status: 'idle',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    schedule: '0 9 * * *',
    actionType: 'http',
    config: {},
    ...overrides,
  }
}

function makeDevTask(overrides: Partial<DevTask> = {}): DevTask {
  return {
    id: 'dev-1',
    name: 'Refactor auth',
    description: '',
    type: 'developmental',
    status: 'idle',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    repoUrl: 'https://example.com/repo.git',
    branch: 'main',
    agentId: 'claude',
    ...overrides,
  }
}

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'routine-1',
    name: 'Deploy pipeline',
    description: '',
    type: 'routine',
    status: 'idle',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    steps: [],
    ...overrides,
  }
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

describe('ConfigModal', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  describe('daily task form', () => {
    it('seeds fields from the task prop', () => {
      const task = makeDailyTask()
      render(<ConfigModal task={task} onClose={vi.fn()} />)

      expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Morning sync')
      expect(screen.getByLabelText('Schedule')).toHaveProperty('value', '0 9 * * *')
    })

    it('saves edited fields via PUT /api/tasks/:id and shows a success message', async () => {
      const task = makeDailyTask()
      mockedApiFetch.mockResolvedValue(jsonResponse({ ...task, name: 'Updated sync' }))

      render(<ConfigModal task={task} onClose={vi.fn()} />)

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated sync' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => {
        expect(screen.getByRole('status').textContent).toBe('Saved')
      })

      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/tasks/daily-1',
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload.name).toBe('Updated sync')
    })

    it('shows a validation error and does not call the API when schedule is cleared', async () => {
      const task = makeDailyTask()
      render(<ConfigModal task={task} onClose={vi.fn()} />)

      fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: '   ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(/schedule/i)
      expect(mockedApiFetch).not.toHaveBeenCalled()
    })

    it('surfaces a server-provided error message when the save fails', async () => {
      const task = makeDailyTask()
      mockedApiFetch.mockResolvedValue(jsonResponse({ error: 'Something broke' }, false, 500))

      render(<ConfigModal task={task} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain('Something broke')
      })
    })

    it('omits config from the payload when no config rows were filled in', async () => {
      const task = makeDailyTask()
      mockedApiFetch.mockResolvedValue(jsonResponse(task))

      render(<ConfigModal task={task} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled())
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload.config).toBeUndefined()
    })

    it('includes config in the payload once a key/value row is filled in', async () => {
      const task = makeDailyTask()
      mockedApiFetch.mockResolvedValue(jsonResponse(task))

      render(<ConfigModal task={task} onClose={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Config key 1'), { target: { value: 'url' } })
      fireEvent.change(screen.getByLabelText('Config value 1'), { target: { value: 'https://x.test' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled())
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload.config).toEqual({ url: 'https://x.test' })
    })
  })

  describe('developmental task form', () => {
    it('seeds fields from the task prop and saves edits', async () => {
      const task = makeDevTask()
      mockedApiFetch.mockResolvedValue(jsonResponse(task))

      render(<ConfigModal task={task} onClose={vi.fn()} />)
      expect(screen.getByLabelText('Repository')).toHaveProperty('value', 'https://example.com/repo.git')

      fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'develop' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled())
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload.branch).toBe('develop')
    })

    it('rejects a blank repository URL client-side before calling the API', async () => {
      const task = makeDevTask()
      render(<ConfigModal task={task} onClose={vi.fn()} />)

      fireEvent.change(screen.getByLabelText('Repository'), { target: { value: '   ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      expect(await screen.findByRole('alert')).toBeTruthy()
      expect(mockedApiFetch).not.toHaveBeenCalled()
    })
  })

  describe('routine task', () => {
    it('renders the name/description mini-form and saves it independently of the step editor', async () => {
      const routine = makeRoutine()
      mockedApiFetch.mockResolvedValue(jsonResponse(routine))

      render(<ConfigModal task={routine} onClose={vi.fn()} />)

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed routine' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save Name & Description' }))

      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/tasks/routine-1',
        expect.objectContaining({ method: 'PUT' }),
      ))
    })
  })

  describe('closing', () => {
    it('calls onClose when the close (✕) button is clicked', () => {
      const onClose = vi.fn()
      render(<ConfigModal task={makeDailyTask()} onClose={onClose} />)

      fireEvent.click(screen.getByRole('button', { name: 'Close configuration modal' }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when the backdrop is clicked but not when the panel itself is clicked', () => {
      const onClose = vi.fn()
      render(<ConfigModal task={makeDailyTask()} onClose={onClose} />)

      fireEvent.click(screen.getByRole('dialog'))
      expect(onClose).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('presentation'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when the Escape key is pressed', () => {
      const onClose = vi.fn()
      render(<ConfigModal task={makeDailyTask()} onClose={onClose} />)

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
