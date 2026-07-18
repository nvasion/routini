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
  },
  resolve: {
    // Fall back to server-local node_modules for server-side packages (e.g. express)
    moduleDirectories: ['node_modules', 'server/node_modules'],
  },
})
