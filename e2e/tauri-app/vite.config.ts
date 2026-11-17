import { defineConfig } from 'vite'

// Built like the tauri-react template: a plain Vite build that the Tauri webview loads.
export default defineConfig({
	clearScreen: false,
	preview: { port: Number(process.env.E2E_TAURI_PORT ?? 5299) },
})
