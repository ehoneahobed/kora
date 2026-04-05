import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm', '@korajs/store'],
    include: ['yjs'],
  },
  resolve: {
    dedupe: ['yjs'],
  },
})
