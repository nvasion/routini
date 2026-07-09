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
  resolve: {
    alias: {
      // React is installed in client/node_modules. Tests that import client-side
      // hook modules (e.g. useTaskEvents) need this alias so Vite can resolve
      // React without adding it as a server-side dependency.
      react: resolve(workspaceRoot, 'client/node_modules/react'),
    },
  },
  test: {
    include: [
      resolve(here, 'src/**/*.test.ts'),
      resolve(workspaceRoot, 'tests/**/*.test.ts'),
    ],
    environment: 'node',
    // scrypt password hashing (used by the auth tests) is intentionally slow
    // for security. Several failed logins in sequence can push a single test
    // past vitest's 5s default. 15s comfortably covers that without hiding
    // real hangs — if a test needs more, it should say so explicitly.
    testTimeout: 15_000,
    server: {
      deps: {
        // Externalize CJS runtime packages so vite hands them to Node's own
        // resolver. Vite's SSR wrapping otherwise mangles internal relative
        // requires (e.g. express's `require('./lib/express')`, supertest's
        // `require('./lib/test.js')`).
        external: [/express/, /cors/, /supertest/, /superagent/, /@sendgrid/, /nodemailer/],
      },
    },
  },
})
