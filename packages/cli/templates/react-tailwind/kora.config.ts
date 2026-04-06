import { defineConfig } from 'korajs/config'

export default defineConfig({
	schema: './src/schema.ts',
	dev: {
		port: 5173,
		watch: {
			enabled: true,
			debounceMs: 300,
		},
		sync: false,
	},
})
