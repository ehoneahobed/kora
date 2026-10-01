import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * DX-3: developer docs must match shipped behavior/signatures.
 * Each assertion encodes the correct state; all fail today.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

function mdFiles(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(join(root, dir))) {
		if (name === '.vitepress' || name === 'plans' || name === 'releases') continue
		const p = join(dir, name)
		if (statSync(join(root, p)).isDirectory()) out.push(...mdFiles(p))
		else if (p.endsWith('.md')) out.push(p)
	}
	return out
}

describe('DX-3 docs match the API', () => {
	test('a useMutation() result object is never called as a function', () => {
		const violations: string[] = []
		for (const file of ['README.md', ...mdFiles('docs')]) {
			const text = read(file)
			for (const m of text.matchAll(/const (\w+) = useMutation\(/g)) {
				const name = m[1] as string
				if (new RegExp(`[^.\\w]${name}\\(`).test(text.slice((m.index ?? 0) + m[0].length))) {
					violations.push(`${file}: ${name}(...) but ${name} is {mutate, mutateAsync, ...}`)
				}
			}
		}
		expect(violations).toEqual([])
	})

	test('React useRichText signature in docs/api/react.md matches (collectionName, recordId, fieldName, options?)', () => {
		const src = read('packages/react/src/hooks/use-rich-text.ts')
		expect(src).toMatch(/useRichText\(\s*collectionName: string,\s*recordId: string,\s*fieldName: string/)
		const doc = read('docs/api/react.md')
		expect(doc).not.toMatch(/useRichText\(\s*recordId: string,\s*field: string\s*\)/)
		expect(doc).not.toMatch(/useRichText\(noteId, 'content'\)/)
	})

	test('docs do not claim useQuery has "no loading state" (first render returns [] placeholder)', () => {
		// packages/react/src/hooks/use-query.ts: snapshot starts as EMPTY_ARRAY and the
		// QueryStore is created in useEffect, so the first render is always [].
		const src = read('packages/react/src/hooks/use-query.ts')
		expect(src).toMatch(/lastSnapshotRef = useRef<readonly T\[\]>\(EMPTY_ARRAY/)
		for (const f of ['docs/api/react.md', 'docs/guide/react-hooks.md']) {
			expect(read(f), f).not.toMatch(/There is no loading state for local data/)
		}
	})

	test('"one line" sync snippet actually connects (autoConnect defaults to off)', () => {
		const lifecycle = read('kora/src/sync-lifecycle.ts')
		expect(lifecycle).toMatch(/autoConnect === true/)
		const idx = read('docs/index.md')
		const snippet = idx.slice(idx.indexOf('one line for multi-device sync') - 200)
		expect(/autoConnect: true|sync\??\.connect\(\)/.test(snippet.slice(0, 800))).toBe(true)
	})

	test('README status line names the current package version', () => {
		const version = JSON.parse(read('kora/package.json')).version as string
		const status = read('README.md').match(/\*\*Public beta \(v([^)]+)\)/)?.[1]
		expect(status).toBe(version)
	})
})
