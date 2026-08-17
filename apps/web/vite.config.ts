import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  // Token de dev injecté à la compilation, et UNIQUEMENT sous `vite serve` : le
  // front n'a alors plus besoin d'un `?token=` dans l'URL. En `vite build` la
  // constante vaut `undefined` — aucun token ne finit dans le bundle de prod,
  // qui ne connaît que l'URL fournie par le shell Electron.
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
