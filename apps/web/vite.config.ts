import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  // Dev token inlined at compile time, and ONLY under `vite serve`: the front then
  // needs no `?token=` in the URL. Under `vite build` the constant is `undefined` —
  // no token ever lands in the production bundle, which only knows the URL handed
  // to it by the Electron shell.
  define: {
    'import.meta.env.VITE_ATELIER_DEV_TOKEN': command === 'serve' ? JSON.stringify(process.env.ATELIER_TOKEN ?? 'atelier-dev') : 'undefined',
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': '/src' },
  },
  build: {
    rollupOptions: {
      output: {
        // Vendor react séparé : meilleur cache long terme + chunk principal
        // sous la limite d'avertissement (500 kB) après le lazy-load du markdown.
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client'],
        },
      },
    },
  },
  server: {
    proxy: {
      // REST and WS both live under /api — one rule covers the whole server surface.
      '/api': { target: 'http://127.0.0.1:4517', ws: true },
    },
  },
}))
