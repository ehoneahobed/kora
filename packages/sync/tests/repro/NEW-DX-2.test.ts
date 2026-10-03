/**
 * NEW-DX-2: no dead serializer in the package graph. Every MessageSerializer implementation
 * in the sync package must be part of its public API (and so documented and tested); the
 * unused schema-driven DynamicProtobufSerializer, which could not encode an envelope, is gone.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../src')

function sourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...sourceFiles(path))
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path)
	}
	return out
}

describe('NEW-DX-2: no dead serializer', () => {
	test('the dynamic serializer module is removed', () => {
		expect(existsSync(join(src, 'protocol/dynamic-serializer.ts'))).toBe(false)
	})

	test('every MessageSerializer implementation is exported from the package entry', () => {
		const index = readFileSync(join(src, 'index.ts'), 'utf8')
		const implementations = sourceFiles(src).flatMap((file) =>
			[
				...readFileSync(file, 'utf8').matchAll(/class\s+(\w+)\s+implements\s+MessageSerializer/g),
			].map((m) => m[1] as string),
		)
		expect(implementations.length).toBeGreaterThan(0)
		const unexported = implementations.filter((name) => !new RegExp(`\\b${name}\\b`).test(index))
		expect(unexported).toEqual([])
	})
})
