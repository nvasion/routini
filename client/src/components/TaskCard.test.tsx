import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TaskCard } from './TaskCard'
import { resetOpenPanelForTests } from '../hooks/openPanelStore'
import type { DailyTask, DevTask, Routine } from '../types'

// TaskCard shares its "which panel is open" state via a module-level store
// (see openPanelStore.ts / useOpenPanel.ts) so more than one card can never
// have its panel open at once. Reset it before/after every test so cases
// don't leak state into one another.

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

describe('TaskCard', () => {
  beforeEach(() => {
    resetOpenPanelForTests()
  })

  afterEach(() => {
    cleanup()
    resetOpenPanelForTests()
  })

  describe('full-card click handling', () => {
    it('opens the configuration panel when clicking anywhere on the card body', () => {
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={vi.fn()} onDelete={vi.fn()} />)

      expect(screen.queryByRole('dialog')).toBeNull()

      // Click the title — not an action button — to exercise the "rest of
      // the card" click target.
      fireEvent.click(screen.getByRole('heading', { name: task.name }))

      expect(screen.getByRole('dialog')).toBeTruthy()
    })

    it('exposes the card as a button with tabIndex 0 for keyboard accessibility', () => {
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={vi.fn()} onDelete={vi.fn()} />)

      const card = screen.getByRole('button', { name: 'View configuration: Morning sync' })
      expect(card.tagName).toBe('ARTICLE')
      expect(card.getAttribute('tabindex')).toBe('0')
      expect(card.getAttribute('aria-expanded')).toBe('false')
    })

    it('opens the panel when the focused card receives an Enter key press', () => {
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={vi.fn()} onDelete={vi.fn()} />)

      const card = screen.getByRole('button', { name: 'View configuration: Morning sync' })
      fireEvent.keyDown(card, { key: 'Enter' })

      expect(screen.getByRole('dialog')).toBeTruthy()
    })

    it('opens the panel when the focused card receives a Space key press', () => {
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={vi.fn()} onDelete={vi.fn()} />)

      const card = screen.getByRole('button', { name: 'View configuration: Morning sync' })
      fireEvent.keyDown(card, { key: ' ' })

      expect(screen.getByRole('dialog')).toBeTruthy()
    })

    it('ignores keys other than Enter/Space on the card', () => {
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={vi.fn()} onDelete={vi.fn()} />)

      const card = screen.getByRole('button', { name: 'View configuration: Morning sync' })
      fireEvent.keyDown(card, { key: 'a' })

      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('reflects the open state via aria-expanded and an updated aria-label', () => {
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={vi.fn()} onDelete={vi.fn()} />)

      fireEvent.click(screen.getByRole('heading', { name: task.name }))

      const openCard = screen.getByRole('button', {
        name: 'Close configuration panel for Morning sync',
      })
      expect(openCard.getAttribute('aria-expanded')).toBe('true')
    })

    it('toggles the panel closed on a second click of the card body', () => {
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={vi.fn()} onDelete={vi.fn()} />)

      const heading = screen.getByRole('heading', { name: task.name })

      fireEvent.click(heading)
      expect(screen.getByRole('dialog')).toBeTruthy()

      fireEvent.click(heading)
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  describe('action buttons stop propagation', () => {
    it('clicking the delete button calls onDelete once and does not open the panel', () => {
      const onDelete = vi.fn()
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={vi.fn()} onDelete={onDelete} />)

      fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))

      expect(onDelete).toHaveBeenCalledTimes(1)
      expect(onDelete).toHaveBeenCalledWith(task.id)
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('clicking the trigger button calls onTrigger once and does not open the panel', () => {
      const onTrigger = vi.fn()
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={onTrigger} onDelete={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: 'Trigger task' }))

      expect(onTrigger).toHaveBeenCalledTimes(1)
      expect(onTrigger).toHaveBeenCalledWith(task.id)
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('disables the trigger button while the task is running and does not call onTrigger', () => {
      const onTrigger = vi.fn()
      const task = makeDailyTask({ status: 'running' })
      render(<TaskCard task={task} onTrigger={onTrigger} onDelete={vi.fn()} />)

      const triggerBtn = screen.getByRole('button', { name: 'Trigger task' })
      expect(triggerBtn).toHaveProperty('disabled', true)

      fireEvent.click(triggerBtn)
      expect(onTrigger).not.toHaveBeenCalled()
    })

    it('the ⚙ button still opens the configuration panel, without a double-toggle from bubbling', () => {
      const task = makeDailyTask()
      render(<TaskCard task={task} onTrigger={vi.fn()} onDelete={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: 'View configuration' }))

      // If the click bubbled past the action-buttons wrapper it would also
      // hit the card's own onClick and immediately toggle the panel closed
      // again — asserting it's open proves that didn't happen.
      expect(screen.getByRole('dialog')).toBeTruthy()
    })

    it('the ⚙ button closes an already-open panel', () => {
      const task = makeDailyTask()
      const { container } = render(
        <TaskCard task={task} onTrigger={vi.fn()} onDelete={vi.fn()} />,
      )
      // Scope to the card itself: once open, the TaskConfigPanel also
      // renders a "Close configuration panel" labelled button (its own ✕),
      // so an unscoped query would be ambiguous.
      const card = within(container).getByRole('button', { name: /configuration: Morning sync/i })

      fireEvent.click(within(card).getByRole('button', { name: 'View configuration' }))
      expect(screen.getByRole('dialog')).toBeTruthy()

      fireEvent.click(within(card).getByRole('button', { name: 'Close configuration panel' }))
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  describe('routine palette population', () => {
    it('passes allTasks through so the routine step editor palette is populated', () => {
      const routine = makeRoutine()
      const daily = makeDailyTask({ id: 'daily-2', name: 'Nightly backup' })
      const dev = makeDevTask({ id: 'dev-2', name: 'Refactor auth' })

      render(
        <TaskCard
          task={routine}
          onTrigger={vi.fn()}
          onDelete={vi.fn()}
          allTasks={[routine, daily, dev]}
        />,
      )

      fireEvent.click(screen.getByText(routine.name))

      expect(screen.getByText('Nightly backup')).toBeTruthy()
      expect(screen.getByText('Refactor auth')).toBeTruthy()
    })

    it('excludes other routines from the palette (routines cannot nest)', () => {
      const routine = makeRoutine()
      const otherRoutine = makeRoutine({ id: 'routine-2', name: 'Other routine' })

      render(
        <TaskCard
          task={routine}
          onTrigger={vi.fn()}
          onDelete={vi.fn()}
          allTasks={[routine, otherRoutine]}
        />,
      )

      fireEvent.click(screen.getByText(routine.name))

      expect(screen.queryByText('Other routine')).toBeNull()
      expect(screen.getByText(/no tasks available/i)).toBeTruthy()
    })

    it('defaults to an empty palette when allTasks is not supplied', () => {
      const routine = makeRoutine()
      render(<TaskCard task={routine} onTrigger={vi.fn()} onDelete={vi.fn()} />)

      fireEvent.click(screen.getByText(routine.name))

      expect(screen.getByText(/no tasks available/i)).toBeTruthy()
    })
  })
})
