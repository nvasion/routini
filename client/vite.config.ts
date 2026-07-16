import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// vite.config.ts runs in Node.js, so process.env is available.
// API_PROXY_TARGET lets the Docker dev environment point Vite's proxy at
// the "server" container (http://server:3001) instead of localhost.
// Local development outside Docker does not need to set this variable.
const apiTarget = process.env['API_PROXY_TARGET'] ?? 'http://localhost:3001'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true
      },
      '/health': {
        target: apiTarget,
        changeOrigin: true
      }
    }
  }
})
