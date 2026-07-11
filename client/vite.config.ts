import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy rules shared between the dev server and `vite preview` so both
// forward /api and /health to the Express backend on port 3001.
const backendProxy = {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  },
  '/health': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: backendProxy,
  },
  // `vite preview` serves the production build on the same port but does NOT
  // inherit server.proxy — without this block every /api call returns a 404.
  preview: {
    port: 5173,
    proxy: backendProxy,
  },
})
