// Server entry point — delegates all app setup to app.ts so that
// tests can import the configured app without starting a real listener.

import { app } from './app.js'

const PORT = process.env.PORT ?? 3001

// Skip listen() in test environments so supertest can bind its own port.
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
}

export { app }
