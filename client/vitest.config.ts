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
    // A page test renders the whole shell (router, org context, fake fetch) in
    // jsdom; alone each stays near a second, but the full suite runs these files
    // in parallel and the heaviest ones exceed vitest's 5s default on a small
    // box. Same reasoning — and the same budget — as server/vitest.config.ts.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
