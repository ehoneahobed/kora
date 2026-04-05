import { defineConfig } from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		'extension/background': 'src/extension/background.ts',
		'extension/content-script': 'src/extension/content-script.ts',
		'extension/devtools': 'src/extension/devtools.ts',
		'extension/panel': 'src/extension/panel.ts',
	},
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
})
