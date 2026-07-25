import { useCallback, useSyncExternalStore } from 'react'
import { subscribeOpenPanel, getOpenPanelId, openPanel, closePanel, togglePanel } from './openPanelStore'

export interface OpenPanelControls {
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
}

/**
 * React hook wiring a single task's card to the shared open-panel store
 * (see openPanelStore.ts), guaranteeing at most one TaskConfigPanel is open
 * across the whole dashboard at any time.
 */
export function useOpenPanel(taskId: string): OpenPanelControls {
  const currentOpenId = useSyncExternalStore(subscribeOpenPanel, getOpenPanelId)
  const isOpen = currentOpenId === taskId

  const open = useCallback(() => openPanel(taskId), [taskId])
  const close = useCallback(() => closePanel(taskId), [taskId])
  const toggle = useCallback(() => togglePanel(taskId), [taskId])

  return { isOpen, open, close, toggle }
}
