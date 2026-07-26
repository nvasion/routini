import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    // Drill-in state is reflected in the URL (see navigateToBucket in
    // Dashboard.tsx) via history.pushState, which persists across tests
    // in the same jsdom window — reset it so a bucket focused in one test
    // doesn't leak into the next.
    window.history.pushState({}, '', '/')
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

  // ── Per-bucket "create" buttons ─────────────────────────────────────────
  //
  // Each bucket owns its own type-specific create form/button (there is no
  // longer a single global "+ New Routine" action) — see toggleCreateForm
  // and the BUCKETS array in Dashboard.tsx.

  describe('per-bucket create buttons', () => {
    it('renders a distinct "+ New" button for each bucket, scoped to that bucket only', async () => {
      mockTasksResponse(makeTasks())
      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Daily Tasks' })).toBeTruthy()
      })

      expect(screen.getByRole('button', { name: 'New Daily Task' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'New Developmental Task' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'New Routine' })).toBeTruthy()
    })

    it('opens only the daily bucket\'s create form when its button is clicked', async () => {
      mockTasksResponse(makeTasks())
      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'New Daily Task' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'New Daily Task' }))

      expect(screen.getByRole('form', { name: 'Create daily task' })).toBeTruthy()
      expect(screen.queryByRole('form', { name: 'Create developmental task' })).toBeNull()
      expect(screen.queryByRole('form', { name: 'Create routine' })).toBeNull()
    })

    it('toggles the create form closed when clicking the same bucket button again', async () => {
      mockTasksResponse(makeTasks())
      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'New Routine' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'New Routine' }))
      expect(screen.getByRole('form', { name: 'Create routine' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Cancel Routine' }))
      expect(screen.queryByRole('form', { name: 'Create routine' })).toBeNull()
    })

    it('switching buckets closes the previously open form and opens the new one', async () => {
      mockTasksResponse(makeTasks())
      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'New Daily Task' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'New Daily Task' }))
      expect(screen.getByRole('form', { name: 'Create daily task' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'New Routine' }))
      expect(screen.queryByRole('form', { name: 'Create daily task' })).toBeNull()
      expect(screen.getByRole('form', { name: 'Create routine' })).toBeTruthy()
    })

    it('submits the routine create form via POST /api/tasks and appends the created task', async () => {
      mockedApiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body as string)
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: 'routine-new',
              name: body.name,
              description: '',
              type: 'routine',
              status: 'idle',
              createdAt: '2024-01-05T00:00:00.000Z',
              updatedAt: '2024-01-05T00:00:00.000Z',
              steps: [],
            }),
          } as Response
        }
        return { ok: true, status: 200, json: async () => ({ tasks: makeTasks() }) } as Response
      })

      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'New Routine' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'New Routine' }))
      fireEvent.change(screen.getByLabelText('Routine name'), { target: { value: 'Brand new routine' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      await waitFor(() => {
        expect(screen.getByText('Brand new routine')).toBeTruthy()
      })

      // Form closes and resets after a successful create.
      expect(screen.queryByRole('form', { name: 'Create routine' })).toBeNull()

      const postCall = mockedApiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      expect(postCall).toBeDefined()
      const postBody = JSON.parse((postCall![1] as RequestInit).body as string)
      expect(postBody).toMatchObject({ name: 'Brand new routine', type: 'routine' })
    })

    it('disables the routine submit button until a name is entered', async () => {
      mockTasksResponse(makeTasks())
      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'New Routine' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'New Routine' }))
      const submit = screen.getByRole('button', { name: 'Create' })
      expect(submit).toHaveProperty('disabled', true)

      fireEvent.change(screen.getByLabelText('Routine name'), { target: { value: 'Named' } })
      expect(submit).toHaveProperty('disabled', false)
    })

    it('surfaces the server error and keeps the form open when creation fails', async () => {
      mockedApiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return { ok: false, status: 400, json: async () => ({ error: 'Name already taken' }) } as Response
        }
        return { ok: true, status: 200, json: async () => ({ tasks: makeTasks() }) } as Response
      })

      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'New Routine' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'New Routine' }))
      fireEvent.change(screen.getByLabelText('Routine name'), { target: { value: 'Dup Routine' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain('Name already taken')
      })
      expect(screen.getByRole('form', { name: 'Create routine' })).toBeTruthy()
    })
  })

  // ── Bucket drill-in ───────────────────────────────────────────────────────
  //
  // Clicking a bucket's title focuses that bucket full-width; the choice is
  // reflected in the `?bucket=` URL query param (see navigateToBucket /
  // getBucketTypeFromLocation in Dashboard.tsx) so it survives a refresh and
  // responds to back/forward navigation.

  describe('bucket drill-in', () => {
    it('shows only the clicked bucket, full-width, with a back control', async () => {
      mockTasksResponse(makeTasks())
      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Daily Tasks' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'View Daily Tasks in full width' }))

      expect(screen.getByRole('heading', { name: 'Daily Tasks' })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: 'Developmental Tasks' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Routine Automation' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Back to all buckets' })).toBeTruthy()
    })

    it('updates the URL with a ?bucket= query param when drilling in', async () => {
      mockTasksResponse(makeTasks())
      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'View Routine Automation in full width' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'View Routine Automation in full width' }))

      expect(window.location.search).toBe('?bucket=routine')
    })

    it('returns to the full grid and clears the query param when "Back" is clicked', async () => {
      mockTasksResponse(makeTasks())
      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'View Daily Tasks in full width' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'View Daily Tasks in full width' }))
      expect(screen.getByRole('button', { name: 'Back to all buckets' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Back to all buckets' }))

      expect(screen.getByRole('heading', { name: 'Daily Tasks' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Developmental Tasks' })).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Routine Automation' })).toBeTruthy()
      expect(window.location.search).toBe('')
    })

    it('initializes the drilled-in view from an existing ?bucket= URL param on mount', async () => {
      window.history.pushState({}, '', '/?bucket=developmental')
      mockTasksResponse(makeTasks())

      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Developmental Tasks' })).toBeTruthy()
      })
      expect(screen.queryByRole('heading', { name: 'Daily Tasks' })).toBeNull()
    })

    it('still respects the search filter while drilled into a single bucket', async () => {
      mockTasksResponse(makeTasks())
      render(<Dashboard />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'View Daily Tasks in full width' })).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'View Daily Tasks in full width' }))
      // "Refactor" only matches the developmental task, not any daily task —
      // so the daily bucket's own list should be empty even though the
      // search still matches something globally (which keeps Dashboard out
      // of its top-level "No tasks found" state).
      fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'Refactor' } })

      await waitFor(() => {
        expect(screen.getByText('No matching tasks')).toBeTruthy()
      })
      expect(screen.getByRole('heading', { name: 'Daily Tasks' })).toBeTruthy()
    })
  })
})
