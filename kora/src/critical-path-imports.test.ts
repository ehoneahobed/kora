import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = __dirname

/** Static (non-type) import or re-export specifiers of every non-test source file. */
function staticValueImports(): Array<{ file: string; specifier: string }> {
	const found: Array<{ file: string; specifier: string }> = []
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(path)
			} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
				const source = readFileSync(path, 'utf8')
				const pattern = /^(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm
				for (const match of source.matchAll(pattern)) {
					if (match[1] === undefined && match[2] !== undefined) {
						found.push({ file: path.slice(SRC.length + 1), specifier: match[2] })
					}
				}
			}
		}
	}
	walk(SRC)
	return found
}

describe('what korajs imports statically (first-visit parity, K3)', () => {
	const imports = staticValueImports()

	test('DevTools is only ever reached through a dynamic import', () => {
		const offenders = imports.filter(({ specifier }) => specifier.startsWith('@korajs/devtools'))
		expect(offenders).toEqual([])
	})

	test('the beta.12 pairwise pipeline is only ever reached through a dynamic import', () => {
		const offenders = imports.filter(
			({ file, specifier }) =>
				specifier.endsWith('legacy-apply-pipeline') && file !== 'legacy-apply-pipeline.ts',
		)
		expect(offenders).toEqual([])
	})

	test('nothing imports protobufjs or the opt-in protobuf serializers', () => {
		const offenders = imports.filter(
			({ specifier }) => specifier.includes('protobuf') || specifier === '@korajs/sync/protobuf',
		)
		expect(offenders).toEqual([])
	})
})
