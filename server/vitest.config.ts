import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const serverNodeModules = resolve(here, 'node_modules')

export default defineConfig({
  test: {
    environment: 'node',
    // The project keeps top-level integration tests under /tests (see CLAUDE.md
    // project structure) while unit tests can live next to server sources.
    include: ['../tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Use forks so each test file runs in a real Node process, letting
    // Node's own resolver handle CJS packages cleanly.
    pool: 'forks',
  },
  resolve: {
    // Test files under /workspace/tests can't reach server/node_modules
    // via the default upward lookup. Alias the packages they need so
    // Vite resolves them to the server's installed copy.
    alias: {
      supertest: resolve(serverNodeModules, 'supertest/index.js'),
    },
  },
})
