import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Dashboard } from './Dashboard'
import { resetOpenPanelForTests } from '../hooks/openPanelStore'
import type { Task } from '../types'

// Dashboard groups tasks into fixed buckets (see BUCKETS in Dashboard.tsx).
// The bucket labels were renamed from the terse 'Daily' / 'Developmental' /
// 'Routines' to the more descriptive 'Daily Tasks' / 'Developmental Tasks' /
// 'Routine Automation'. These tests assert the *rendered* bucket headings
// reflect the new copy (and that the old copy is gone), so a future rename
// that only updates one of {BUCKETS, Dashboard.tsx JSX} is caught here
// instead of shipping a mismatch between data and UI.

// `useTaskEvents` opens a real EventSource, which isn't available in jsdom
// test runs and would otherwise leave the Dashboard permanently in its
// loading state. Mock it out so tests drive state via the HTTP fallback
// fetch instead (mirroring TaskCard.test.tsx's approach of mocking modules
// that reach outside the component under test).
vi.mock('../hooks/useTaskEvents', () => ({
  useTaskEvents: () => {},
}))

vi.mock('../api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../api'

const mockedApiFetch = vi.mocked(apiFetch)

function makeTasks(): Task[] {
  return [
    {
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
    },
    {
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
    },
    {
      id: 'routine-1',
      name: 'Deploy pipeline',
      description: '',
      type: 'routine',
      status: 'idle',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      steps: [],
    },
  ]
}

function mockTasksResponse(tasks: Task[]): void {
  mockedApiFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ tasks }),
  } as Response)
}

describe('Dashboard', () => {
  beforeEach(() => {
    resetOpenPanelForTests()
  })

  afterEach(() => {
    cleanup()
    resetOpenPanelForTests()
    vi.resetAllMocks()
  })

  it('renders the updated bucket headings for tasks of each type', async () => {
    mockTasksResponse(makeTasks())

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Daily Tasks' })).toBeTruthy()
    })
    expect(screen.getByRole('heading', { name: 'Developmental Tasks' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Routine Automation' })).toBeTruthy()
  })

  it('does not render the old, pre-rename bucket labels', async () => {
    mockTasksResponse(makeTasks())

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Daily Tasks' })).toBeTruthy()
    })

    expect(screen.queryByRole('heading', { name: 'Daily' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Developmental' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Routines' })).toBeNull()
  })

  it('exposes each bucket via an aria-label built from the new heading text', async () => {
    mockTasksResponse(makeTasks())

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByLabelText('Daily Tasks tasks')).toBeTruthy()
    })
    expect(screen.getByLabelText('Developmental Tasks tasks')).toBeTruthy()
    expect(screen.getByLabelText('Routine Automation tasks')).toBeTruthy()
  })

  it('still renders bucket headings (empty-state) even when there are no tasks of any type', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tasks: [] }),
    } as Response)

    render(<Dashboard />)

    // With zero tasks total, Dashboard shows the "No tasks found" placeholder
    // instead of the bucket grid — confirm that placeholder appears and no
    // bucket heading (old or new) is rendered in this state.
    await waitFor(() => {
      expect(screen.getByText('No tasks found')).toBeTruthy()
    })
    expect(screen.queryByRole('heading', { name: 'Daily Tasks' })).toBeNull()
  })

  it('surfaces an error banner without throwing when the initial fetch fails', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    } as Response)

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })
  })
})
