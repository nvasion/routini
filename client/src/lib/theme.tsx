// Theme: Routini (default), TynHub dark, TynHub light. Stored per browser and
// applied as data-theme on <html>, which switches every token in tokens.css.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export const THEMES = [
  { id: 'routini', label: 'Routini' },
  { id: 'tynhub-dark', label: 'TynHub dark' },
  { id: 'tynhub-light', label: 'TynHub light' },
] as const
export type ThemeId = (typeof THEMES)[number]['id']

const KEY = 'routini.theme'

export function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY)
    if (THEMES.some((t) => t.id === v)) return v as ThemeId
  } catch {
    // storage unavailable
  }
  return 'routini'
}

const ThemeContext = createContext<{ theme: ThemeId; setTheme: (t: ThemeId) => void }>({ theme: 'routini', setTheme: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      // storage unavailable: theme still applies for this session
    }
  }, [theme])
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
