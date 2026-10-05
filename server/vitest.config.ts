import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Workspace root is one level up from server/
const workspaceRoot = path.resolve(__dirname, '..')

export default defineConfig({
  root: workspaceRoot,
  // Write optimizer cache inside the workspace rather than /tmp (which may be small).
  cacheDir: path.resolve(__dirname, '../.vitest-cache'),
  test: {
    // Include root-level integration tests, server-specific tests, and server unit tests
    include: ['tests/**/*.test.ts', 'server/tests/**/*.test.ts', 'server/src/**/*.test.ts'],
    environment: 'node',
    // Each test file boots embedded Postgres (PGlite) and clones a migrated snapshot;
    // under full-suite parallelism that can exceed vitest's 5s default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    // Fall back to server-local node_modules for server-side packages (e.g. express)
    moduleDirectories: ['node_modules', 'server/node_modules'],
    // Test files live outside server/, so bare imports of server-only packages need a pointer.
    alias: { ws: path.resolve(__dirname, 'node_modules/ws/wrapper.mjs') },
  },
})
