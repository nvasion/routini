// Data hooks: a small fetch-and-refresh hook, and live server-sent events.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

export interface Resource<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
  setData: (d: T | ((prev: T | null) => T | null)) => void
}

/** GETs `path` (null = skip) and keeps the result; `reload()` refetches without clearing. */
export function useApi<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(path !== null)
  const current = useRef(path)
  current.current = path

  const load = useCallback(async () => {
    if (!path) return
    setLoading(true)
    try {
      const d = await api<T>(path)
      if (current.current === path) {
        setData(d)
        setError(null)
      }
    } catch (err) {
      if (current.current === path) setError((err as Error).message)
    } finally {
      if (current.current === path) setLoading(false)
    }
  }, [path])

  useEffect(() => {
    setData(null)
    void load()
  }, [load])

  return { data, error, loading, reload: load, setData: setData as Resource<T>['setData'] }
}

/**
 * Subscribes to a server-sent event stream. The browser's EventSource resumes
 * from the last event id on reconnect. `onEvent` receives (type, data).
 * Closes on an `end` event.
 */
export function useEventStream(url: string | null, onEvent: (type: string, data: unknown) => void, types: string[]): void {
  const handler = useRef(onEvent)
  handler.current = onEvent
  const typesKey = types.join(',')

  useEffect(() => {
    if (!url || typeof EventSource === 'undefined') return
    const es = new EventSource(url, { withCredentials: true })
    const listeners: Array<[string, (e: MessageEvent) => void]> = []
    for (const t of [...typesKey.split(','), 'end']) {
      const l = (e: MessageEvent) => {
        let data: unknown = null
        try {
          data = JSON.parse(e.data as string)
        } catch {
          data = e.data
        }
        handler.current(t, data)
        if (t === 'end') es.close()
      }
      es.addEventListener(t, l as EventListener)
      listeners.push([t, l])
    }
    return () => {
      for (const [t, l] of listeners) es.removeEventListener(t, l as EventListener)
      es.close()
    }
  }, [url, typesKey])
}

/** Re-renders every `ms` (for relative times and running durations). */
export function useTick(ms = 1000): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms)
    return () => clearInterval(t)
  }, [ms])
  return n
}
