import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': '/src' },
  },
  server: {
    proxy: {
      // REST and WS both live under /api — one rule covers the whole server surface.
      '/api': { target: 'http://127.0.0.1:4517', ws: true },
    },
  },
})
