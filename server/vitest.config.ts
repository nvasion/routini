import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(here, '..')

/**
 * Test suites live at the workspace root under `tests/`, but the runtime
 * dependencies (express, cors) are installed under `server/node_modules`.
 * We keep vitest's project root at the server package so vite's resolver
 * finds them, and use absolute globs to discover the workspace-level tests.
 *
 * We explicitly externalize the runtime CJS packages so vite hands them to
 * Node's own resolver — vite's SSR wrapping otherwise mangles express's
 * internal `require('./lib/express')` relative resolution.
 */
export default defineConfig({
  test: {
    include: [
      resolve(here, 'src/**/*.test.ts'),
      resolve(workspaceRoot, 'tests/**/*.test.ts'),
    ],
    environment: 'node',
    server: {
      deps: {
        external: [/express/, /cors/],
      },
    },
  },
})
