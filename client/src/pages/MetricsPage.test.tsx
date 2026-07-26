import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MetricsPage } from './MetricsPage'
import type { Task } from '../types'

// `useTaskEvents` opens a real EventSource, which isn't available in jsdom —
// mock it out (mirrors Dashboard.test.tsx / TaskCard.test.tsx) so MetricsPage
// drives its state from the HTTP fallback fetch instead.
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
      description: '',
      type: 'daily',
      status: 'succeeded',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-03T00:00:00.000Z',
      schedule: '0 9 * * *',
      actionType: 'http',
      config: {},
    },
    {
      id: 'dev-1',
      name: 'Refactor auth',
      description: '',
      type: 'developmental',
      status: 'failed',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      repoUrl: 'https://example.com/repo.git',
      branch: 'main',
      agentId: 'claude',
    },
    {
      id: 'routine-1',
      name: 'Deploy pipeline',
      description: '',
      type: 'routine',
      status: 'failed',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-04T00:00:00.000Z',
      steps: [],
    },
    {
      id: 'daily-2',
      name: 'Nightly backup',
      description: '',
      type: 'daily',
      status: 'running',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      schedule: '0 0 * * *',
      actionType: 'ssh',
      config: {},
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

describe('MetricsPage', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('shows a loading state before the initial fetch resolves', () => {
    mockedApiFetch.mockReturnValue(new Promise<Response>(() => {})) // never resolves
    render(<MetricsPage />)

    expect(screen.getByText('Loading metrics…')).toBeTruthy()
  })

  it('renders summary counts derived from the fetched tasks', async () => {
    mockTasksResponse(makeTasks())
    render(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getByText('Task health at a glance')).toBeTruthy()
    })

    const summary = screen.getByRole('list')
    const items = within(summary).getAllByRole('listitem')
    expect(items).toHaveLength(4)

    expect(within(summary).getByText('4')).toBeTruthy() // total
    expect(within(summary).getByText('Total')).toBeTruthy()
    expect(within(summary).getByText('Succeeded')).toBeTruthy()
    expect(within(summary).getByText('Running')).toBeTruthy()
    expect(within(summary).getByText('Failed')).toBeTruthy()
  })

  it('lists failed tasks sorted by most-recently-updated first', async () => {
    mockTasksResponse(makeTasks())
    render(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeTruthy()
    })

    const rows = screen.getAllByRole('row')
    // rows[0] is the header row; failed tasks are 'Deploy pipeline' (2024-01-04)
    // and 'Refactor auth' (2024-01-02) — most recent first.
    expect(within(rows[1]).getByText('Deploy pipeline')).toBeTruthy()
    expect(within(rows[2]).getByText('Refactor auth')).toBeTruthy()
  })

  it('links each failed task row to its logs endpoint', async () => {
    mockTasksResponse(makeTasks())
    render(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeTruthy()
    })

    const link = screen.getAllByRole('link', { name: 'View logs' })[0]
    expect(link.getAttribute('href')).toBe('/api/tasks/routine-1/logs')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('shows an empty state instead of a table when there are no failed tasks', async () => {
    mockTasksResponse(makeTasks().filter(t => t.status !== 'failed'))
    render(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getByText('No failed tasks')).toBeTruthy()
    })
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('surfaces an error banner without throwing when the initial fetch fails', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    } as Response)

    render(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })
  })

  it('renders zeroed-out summary counts when there are no tasks at all', async () => {
    mockTasksResponse([])
    render(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getByText('No failed tasks')).toBeTruthy()
    })

    const summary = screen.getByRole('list')
    const items = within(summary).getAllByRole('listitem')
    items.forEach(item => {
      expect(within(item).getByText('0')).toBeTruthy()
    })
  })
})
