import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { build } from 'esbuild'
import { rollup } from 'rollup'
import { describe, expect, it } from 'vitest'

// The SQLite worker file of every template is `import '@korajs/store/sqlite-wasm/worker'`: an
// import for its effect alone (it installs `self.onmessage`). A package that declares
// `"sideEffects": false` lets a bundler drop it, and the store then waits forever for a worker
// that never answers (first-visit parity, S4a). This bundles the published entry the way an app
// does and asserts the handler is still in the output.
describe('the SQLite worker entry survives tree-shaking', () => {
	it('keeps self.onmessage when the worker file only imports the entry', async () => {
		const result = await build({
			stdin: {
				contents: "import '@korajs/store/sqlite-wasm/worker'\n",
				resolveDir: join(__dirname, '..', '..'),
				loader: 'ts',
			},
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
			treeShaking: true,
			external: ['@sqlite.org/sqlite-wasm'],
			logLevel: 'silent',
		})
		const output = result.outputFiles[0]?.text ?? ''
		expect(output).toContain('onmessage')
	})

	// Vite builds with Rollup, not esbuild. This applies the rule Vite's resolver applies: a module
	// of a package whose package.json lists `sideEffects` has side effects only if it is listed.
	// webpack and turbopack read the same field but are not tested here.
	it('keeps self.onmessage in a Rollup build that honours package.json sideEffects', async () => {
		const requireFrom = createRequire(join(__dirname, '..', '..', 'package.json'))
		const bundle = await rollup({
			input: 'worker-entry',
			external: ['@sqlite.org/sqlite-wasm'],
			onwarn: () => {},
			plugins: [
				{
					name: 'entry',
					resolveId(source, importer) {
						if (source === 'worker-entry') return '\0worker-entry'
						if (source === '@korajs/store/sqlite-wasm/worker') {
							return resolveWithSideEffects(requireFrom.resolve(source))
						}
						if (importer && source.startsWith('.') && !importer.startsWith('\0')) return null
						return null
					},
					load(id) {
						return id === '\0worker-entry' ? "import '@korajs/store/sqlite-wasm/worker'\n" : null
					},
				},
			],
		})
		const { output } = await bundle.generate({ format: 'esm' })
		expect(output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n')).toContain(
			'onmessage',
		)
	})
})

function resolveWithSideEffects(file: string): { id: string; moduleSideEffects: boolean } {
	// The nearest package.json above the file.
	let dir = join(file, '..')
	for (;;) {
		try {
			const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
				sideEffects?: boolean | string[]
			}
			const listed = manifest.sideEffects
			const rel = `./${relative(dir, file).split(sep).join('/')}`
			return {
				id: file,
				moduleSideEffects: Array.isArray(listed) ? listed.includes(rel) : listed !== false,
			}
		} catch {
			dir = join(dir, '..')
		}
	}
}
