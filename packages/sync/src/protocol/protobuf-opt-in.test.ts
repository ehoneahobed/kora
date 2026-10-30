import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '..')

/** Source files of the package that are not tests. */
function sourceFiles(dir: string): string[] {
	const files: string[] = []
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry)
		if (statSync(path).isDirectory()) {
			if (entry !== 'benchmarks') files.push(...sourceFiles(path))
		} else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
			files.push(path)
		}
	}
	return files
}

/** The module specifiers a file imports or re-exports with a static, value-carrying statement. */
function staticValueImports(source: string): string[] {
	const specifiers: string[] = []
	const pattern = /^(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm
	for (const match of source.matchAll(pattern)) {
		if (match[1] === undefined && match[2] !== undefined) specifiers.push(match[2])
	}
	return specifiers
}

describe('the protobuf wire format is an explicit opt-in (first-visit parity, K3)', () => {
	// protobufjs is ~30 KB gzip of critical-path JavaScript that a JSON-only app never runs:
	// only the opt-in entries may import it statically.
	const optIn = new Set(['protocol/protobuf-serializer.ts', 'protobuf.ts', 'index.ts'])

	test('no module on the default path imports the protobuf serializer or protobufjs', () => {
		const offenders: string[] = []
		for (const file of sourceFiles(SRC)) {
			const name = relative(SRC, file)
			if (optIn.has(name)) continue
			for (const specifier of staticValueImports(readFileSync(file, 'utf8'))) {
				if (specifier.includes('protobufjs') || specifier.endsWith('protobuf-serializer')) {
					offenders.push(`${name} -> ${specifier}`)
				}
			}
		}
		expect(offenders).toEqual([])
	})

	test('the JSON serializer module does not touch protobufjs', () => {
		const source = readFileSync(join(SRC, 'protocol', 'serializer.ts'), 'utf8')
		expect(source).not.toContain('protobufjs')
	})

	test('only the package entry re-exports the protobuf serializers, and the package is side-effect free', () => {
		const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
			sideEffects?: unknown
			exports: Record<string, unknown>
		}
		// Without sideEffects:false a bundler keeps the `protobufjs` import behind the re-export.
		expect(manifest.sideEffects).toBe(false)
		expect(Object.keys(manifest.exports)).toContain('./protobuf')
	})
})
