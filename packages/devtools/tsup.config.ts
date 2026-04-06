import { copyFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

export default defineConfig([
	// Library build (for npm consumers)
	{
		entry: { index: 'src/index.ts' },
		format: ['esm', 'cjs'],
		dts: true,
		sourcemap: true,
		clean: true,
	},
	// Extension build — each entry must be self-contained (no code splitting)
	// because Chrome extensions cannot load files outside their directory.
	{
		entry: {
			'extension/background': 'src/extension/background.ts',
			'extension/content-script': 'src/extension/content-script.ts',
			'extension/devtools': 'src/extension/devtools.ts',
			'extension/panel': 'src/extension/panel.ts',
		},
		format: ['esm', 'cjs'],
		dts: true,
		sourcemap: true,
		splitting: false,
		noExternal: [/.*/],
		// Copy static extension assets after build
		onSuccess: async () => {
			copyFileSync('src/extension/manifest.json', 'dist/extension/manifest.json')
			copyFileSync('src/extension/devtools-page.html', 'dist/extension/devtools-page.html')
			copyFileSync('src/extension/devtools.html', 'dist/extension/devtools.html')
		},
	},
])
