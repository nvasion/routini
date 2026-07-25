import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Vitest config for client-side component tests (e.g. TaskCard.test.tsx).
//
// Kept separate from server/vitest.config.ts, which only discovers
// `tests/**`, `server/tests/**`, and `server/src/**` and runs with a plain
// Node environment — neither is suitable for rendering React components.
// This config adds a jsdom environment (required by @testing-library/react
// and by Vite's CSS-import handling, which injects a <style> tag) and the
// React plugin (JSX transform) so component tests can render real DOM.
//
// Run with `npx vitest run --config vitest.config.ts` from `client/`.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
})
