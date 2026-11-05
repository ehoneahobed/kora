import { join } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

// Access rules are validated and compiled by about 16 KB of code that an app's first paint does
// not need. A production build of the lite graph must not contain it in the entry chunk (it
// loads with the runtime); a development build must, so a bad rule still fails at defineSchema
// (first-visit parity, S4a).
const MARKER = 'access.memberships needs access.roles'

/** Bundles an import of `korajs` with code splitting and returns the entry chunk's text. */
async function entryChunk(nodeEnv: 'production' | 'development'): Promise<string> {
	const result = await build({
		stdin: {
			contents:
				"import { createApp, defineSchema, t } from 'korajs'\nconsole.log(createApp, defineSchema, t)\n",
			resolveDir: join(__dirname, '..', '..'),
			loader: 'ts',
			sourcefile: 'entry.ts',
		},
		bundle: true,
		write: false,
		splitting: true,
		outdir: 'out',
		format: 'esm',
		platform: 'browser',
		treeShaking: true,
		define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) },
		external: ['@sqlite.org/sqlite-wasm', 'react', 'vue', 'svelte', 'yjs', 'ws'],
		logLevel: 'silent',
	})
	const entry = result.outputFiles.find((file) => /[\/]stdin.js$/.test(file.path))
	return entry?.text ?? ''
}

describe('the lite graph and access-rule validation', () => {
	it('leaves the validation code out of the entry chunk of a production bundle', async () => {
		const output = await entryChunk('production')
		expect(output.length).toBeGreaterThan(0)
		expect(output).not.toContain(MARKER)
	})

	it('keeps it in a development bundle, so defineSchema validates eagerly', async () => {
		// The compiler sits in a shared chunk the entry imports; the entry registers it.
		const output = await entryChunk('development')
		expect(output).toContain('registerAccessCompiler')
	})
})
