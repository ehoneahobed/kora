import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * Invariant I1 (docs/design/instant-ui-updates.md 6, 12.4): the overlay is never the
 * source of truth. A static check of the module graph:
 *
 * - the write path (`mutations/write-ops.ts` and everything it imports, transitively)
 *   never imports `overlay/*`;
 * - nothing in `packages/sync` imports the overlay, directly or through a deep
 *   `@korajs/store` path.
 *
 * Only the write ENTRY points (`mutations/execute-*.ts`) may import the overlay, to report
 * a write's outcome; they never read from it.
 */
const here = dirname(fileURLToPath(import.meta.url))
const storeSrc = resolve(here, '..')
const syncSrc = resolve(storeSrc, '../../sync/src')

const IMPORT_SPECIFIER =
	/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

function specifiersOf(file: string): string[] {
	const source = readFileSync(file, 'utf8')
	const out: string[] = []
	for (const match of source.matchAll(IMPORT_SPECIFIER)) {
		// `import type` / `export type` are erased at build time: not a runtime edge.
		if (/^\s*(?:import|export)\s+type\s/.test(match[0])) continue
		const specifier = match[1] ?? match[2]
		if (specifier) out.push(specifier)
	}
	return out
}

function resolveRelative(from: string, specifier: string): string | null {
	if (!specifier.startsWith('.')) return null
	const base = resolve(dirname(from), specifier)
	for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
		try {
			if (statSync(candidate).isFile()) return candidate
		} catch {
			// try the next candidate
		}
	}
	return null
}

/** Every file reachable from `entry` through relative (runtime) imports. */
function reachableFrom(entry: string): Set<string> {
	const seen = new Set<string>()
	const queue = [entry]
	while (queue.length > 0) {
		const file = queue.pop() as string
		if (seen.has(file)) continue
		seen.add(file)
		for (const specifier of specifiersOf(file)) {
			const target = resolveRelative(file, specifier)
			if (target) queue.push(target)
		}
	}
	return seen
}

function sourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
		else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path)
	}
	return out
}

const isOverlayFile = (file: string): boolean =>
	relative(storeSrc, file).split('/')[0] === 'overlay'

describe('I1: nothing on the write path or in sync reads the overlay', () => {
	test('the module graph walker sees the real write path (guards against a vacuous pass)', () => {
		const reachable = reachableFrom(join(storeSrc, 'mutations/write-ops.ts'))
		const names = [...reachable].map((file) => relative(storeSrc, file))
		expect(names).toContain('mutations/write-ops.ts')
		expect(names).toContain('mutations/write-shapes.ts')
		expect(names).toContain('serialization/serializer.ts')
		expect(reachable.size).toBeGreaterThan(8)
		// ... and it would notice an overlay import: the entry points do import it.
		const entry = reachableFrom(join(storeSrc, 'mutations/execute-insert.ts'))
		expect([...entry].some(isOverlayFile)).toBe(true)
	})

	test('write-ops.ts and its transitive imports never import overlay/*', () => {
		const reachable = reachableFrom(join(storeSrc, 'mutations/write-ops.ts'))
		const offenders = [...reachable].filter(isOverlayFile).map((file) => relative(storeSrc, file))
		expect(offenders).toEqual([])
	})

	test('the rest of the write path (run-local-write, write-context, write-shapes) never imports overlay/*', () => {
		for (const name of [
			'run-local-write.ts',
			'write-context.ts',
			'write-shapes.ts',
			'secret-write.ts',
		]) {
			const reachable = reachableFrom(join(storeSrc, 'mutations', name))
			const offenders = [...reachable].filter(isOverlayFile).map((file) => relative(storeSrc, file))
			expect({ name, offenders }).toEqual({ name, offenders: [] })
		}
	})

	test('the overlay imports the write path, never the other way round (one direction)', () => {
		const predict = reachableFrom(join(storeSrc, 'overlay/predict.ts'))
		expect([...predict].map((file) => relative(storeSrc, file))).toContain(
			'mutations/write-shapes.ts',
		)
	})

	test('packages/sync never imports the overlay', () => {
		const offenders: string[] = []
		for (const file of sourceFiles(syncSrc)) {
			for (const specifier of specifiersOf(file)) {
				if (/(^|\/)overlay(\/|$)/.test(specifier))
					offenders.push(`${relative(syncSrc, file)}: ${specifier}`)
			}
		}
		expect(offenders).toEqual([])
	})

	// S4 exposes only the option types (`InstantUpdatesOptions`, `WriteOptions`, declared in
	// types.ts); the overlay modules themselves stay internal (design 16.6).
	test('no overlay module is exported from the store package surface', () => {
		for (const name of ['index.ts', 'internal.ts']) {
			const exported = specifiersOf(join(storeSrc, name))
			expect(exported.filter((specifier) => /overlay/.test(specifier))).toEqual([])
		}
	})
})
