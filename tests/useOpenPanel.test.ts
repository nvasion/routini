import { describe, it, expect, beforeEach } from 'vitest'
import {
  getOpenPanelId,
  openPanel,
  closePanel,
  togglePanel,
  subscribeOpenPanel,
  resetOpenPanelForTests,
} from '../client/src/hooks/openPanelStore'

// These tests exercise the plain-JS store backing useOpenPanel — the "only
// one configuration panel open at a time" state machine shared by every
// TaskCard on the dashboard. The React hook itself (useSyncExternalStore)
// isn't exercised here since this project has no client-side component
// rendering harness (jsdom / React Testing Library) configured; the store
// functions are exported specifically so this critical behavior is still
// testable without one.

describe('useOpenPanel store', () => {
  beforeEach(() => {
    resetOpenPanelForTests()
  })

  it('starts with no panel open', () => {
    expect(getOpenPanelId()).toBeNull()
  })

  it('openPanel opens the requested panel', () => {
    openPanel('task-1')
    expect(getOpenPanelId()).toBe('task-1')
  })

  it('opening a second panel closes the first — only one open at a time', () => {
    openPanel('task-1')
    openPanel('task-2')
    expect(getOpenPanelId()).toBe('task-2')
  })

  it('closePanel only closes if it is the currently-open panel', () => {
    openPanel('task-1')
    closePanel('task-2') // not the open one — should be a no-op
    expect(getOpenPanelId()).toBe('task-1')

    closePanel('task-1')
    expect(getOpenPanelId()).toBeNull()
  })

  it('closePanel on an already-closed store is a no-op', () => {
    closePanel('task-1')
    expect(getOpenPanelId()).toBeNull()
  })

  it('togglePanel opens when closed and closes when already open', () => {
    togglePanel('task-1')
    expect(getOpenPanelId()).toBe('task-1')

    togglePanel('task-1')
    expect(getOpenPanelId()).toBeNull()
  })

  it('togglePanel on a different task switches the open panel', () => {
    togglePanel('task-1')
    togglePanel('task-2')
    expect(getOpenPanelId()).toBe('task-2')
  })

  it('notifies subscribers on open, close, and toggle', () => {
    let notifications = 0
    const unsubscribe = subscribeOpenPanel(() => {
      notifications++
    })

    openPanel('task-1')
    closePanel('task-1')
    togglePanel('task-2')

    expect(notifications).toBe(3)
    unsubscribe()
  })

  it('does not notify when opening the already-open panel (idempotent)', () => {
    openPanel('task-1')
    let notifications = 0
    const unsubscribe = subscribeOpenPanel(() => {
      notifications++
    })

    openPanel('task-1') // already open — should not notify
    expect(notifications).toBe(0)
    unsubscribe()
  })

  it('does not notify when closing a panel that is not open', () => {
    openPanel('task-1')
    let notifications = 0
    const unsubscribe = subscribeOpenPanel(() => {
      notifications++
    })

    closePanel('task-2') // task-2 was never open
    expect(notifications).toBe(0)
    unsubscribe()
  })

  it('unsubscribed listeners stop receiving notifications', () => {
    let notifications = 0
    const unsubscribe = subscribeOpenPanel(() => {
      notifications++
    })

    openPanel('task-1')
    expect(notifications).toBe(1)

    unsubscribe()
    closePanel('task-1')
    expect(notifications).toBe(1) // unchanged — listener was removed
  })

  it('supports multiple concurrent listeners (one per mounted TaskCard)', () => {
    let a = 0
    let b = 0
    const unsubA = subscribeOpenPanel(() => a++)
    const unsubB = subscribeOpenPanel(() => b++)

    openPanel('task-1')

    expect(a).toBe(1)
    expect(b).toBe(1)

    unsubA()
    unsubB()
  })
})
