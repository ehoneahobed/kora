import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('package.json sideEffects', () => {
	const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
		sideEffects?: boolean | string[]
		exports: Record<string, { import?: { default?: string }; require?: { default?: string } }>
	}

	// An app imports the worker entry for its effect only (`import '@korajs/store/sqlite-wasm/worker'`
	// installs the message handler). With `"sideEffects": false` a bundler drops that import, and the
	// store's open then waits forever for a worker that never answers.
	it('keeps the SQLite WASM worker entry, which is imported for its side effects', () => {
		expect(Array.isArray(manifest.sideEffects)).toBe(true)
		const worker = manifest.exports['./sqlite-wasm/worker']
		const files = [worker?.import?.default, worker?.require?.default]
		for (const file of files) {
			expect(file).toBeDefined()
			expect(manifest.sideEffects).toContain(file)
		}
	})
})
