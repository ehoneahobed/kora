import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri apps use native SQLite — no WASM, no OPFS, no cross-origin isolation needed.
export default defineConfig({
  plugins: [react()],
  // Prevent Vite from obscuring Rust compilation errors
  clearScreen: false,
  server: {
    // Tauri expects a fixed port; fail if it's not available
    strictPort: true,
  },
  // Environment variables with this prefix are exposed to the app
  envPrefix: ['VITE_', 'TAURI_'],
})
