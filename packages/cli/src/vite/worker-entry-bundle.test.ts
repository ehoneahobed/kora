import { join } from 'node:path'
import { build } from 'esbuild'
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
})
