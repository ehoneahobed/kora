import { readFileSync, readdirSync } from 'node:fs'
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

	// A bundler keeps a module imported only for its effect when it is listed in sideEffects. If
	// the handler body moved into a shared chunk (a tsup split), the listed file would become an
	// empty re-export and the effect would be dropped silently. The source says where the handler
	// lives; the build must put it in a listed file.
	it('lists every built file that installs the worker message handler', () => {
		const source = readFileSync(join(__dirname, 'adapters', 'sqlite-wasm-worker.ts'), 'utf8')
		expect(source).toMatch(/self\.onmessage\s*=/)
		const dist = join(__dirname, '..', 'dist')
		const listed = new Set(
			(manifest.sideEffects as string[]).map((file) => file.replace('./dist/', '')),
		)
		const walk = (dir: string, prefix = ''): string[] =>
			readdirSync(join(dist, dir), { withFileTypes: true }).flatMap((entry) =>
				entry.isDirectory()
					? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
					: [`${prefix}${entry.name}`],
			)
		const installers = walk('')
			.filter((file) => /\.(c?js)$/.test(file))
			.filter((file) => /^\s*self\.onmessage\s*=/m.test(readFileSync(join(dist, file), 'utf8')))
		expect(installers.length).toBeGreaterThan(0)
		for (const file of installers) expect(listed.has(file)).toBe(true)
	})
})
