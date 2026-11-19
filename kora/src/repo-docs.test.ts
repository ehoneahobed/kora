import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Repository-wide documentation checks: every published package ships a README, and every
 * error code in the source is listed in docs/api/errors.md (the page the `fix` hints and the
 * troubleshooting guide point at). Codes are read from KoraError constructions and, in files
 * that define a KoraError subclass, from `code: 'LITERAL'` sites (event and result codes too).
 */
const root = resolve(__dirname, '../..')

function packageDirs(): string[] {
	const dirs = readdirSync(join(root, 'packages')).map((name) => join(root, 'packages', name))
	return [...dirs, join(root, 'kora')].filter((dir) => existsSync(join(dir, 'package.json')))
}

function sourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) {
			if (name !== 'node_modules' && name !== 'dist') out.push(...sourceFiles(path))
		} else if (/\.tsx?$/.test(name) && !/\.(test|spec|property\.test)\.tsx?$/.test(name)) {
			out.push(path)
		}
	}
	return out
}

/** The text of a call's argument list starting at `open` (the index of its `(`). */
function argumentText(source: string, open: number): string {
	let depth = 0
	for (let i = open; i < source.length; i++) {
		const ch = source[i]
		if (ch === '(') depth++
		else if (ch === ')') {
			depth--
			if (depth === 0) return source.slice(open + 1, i)
		}
	}
	return ''
}

/** Codes passed to KoraError: `super(message, 'CODE', ...)` in a subclass, or `new KoraError(...)`. */
function koraErrorCodes(source: string): string[] {
	if (!source.includes('KoraError')) return []
	const codes: string[] = []
	for (const match of source.matchAll(/\b(?:super|new KoraError)\s*\(/g)) {
		const args = argumentText(source, (match.index ?? 0) + match[0].length - 1)
		const code = /^[\s\S]*?,\s*'([A-Z][A-Z0-9_]{2,})'/.exec(args)?.[1]
		if (code) codes.push(code)
	}
	// A subclass that takes its code as a parameter typed by a literal union
	// (`code: 'STAMP_USER_UNKNOWN' | 'STAMP_MISMATCH'`).
	if (/extends KoraError\b/.test(source)) {
		for (const match of source.matchAll(/\bcode\??:\s*((?:'[A-Z][A-Z0-9_]{2,}'\s*\|?\s*)+)/g)) {
			for (const literal of (match[1] ?? '').matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) {
				if (literal[1]) codes.push(literal[1])
			}
		}
	}
	return codes
}

describe('repository documentation', () => {
	test('every published package has a README', () => {
		const missing = packageDirs()
			.filter((dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).private !== true)
			.filter((dir) => !existsSync(join(dir, 'README.md')))
			.map((dir) => dir.slice(root.length + 1))
		expect(missing).toEqual([])
	})

	test('every error code in the source is listed in docs/api/errors.md', () => {
		const docs = readFileSync(join(root, 'docs/api/errors.md'), 'utf8')
		const missing = new Set<string>()
		for (const dir of packageDirs()) {
			const src = join(dir, 'src')
			if (!existsSync(src)) continue
			for (const file of sourceFiles(src)) {
				for (const code of koraErrorCodes(readFileSync(file, 'utf8'))) {
					if (!new RegExp(`\\b${code}\\b`).test(docs)) missing.add(code)
				}
			}
		}
		expect([...missing].sort()).toEqual([])
	})

	test('the code scanner reads multi-line super calls and ignores message text', () => {
		const source = `class A extends KoraError {
			constructor(n: number) {
				super(
					\`Saw \${format('X', n)} items\`,
					'SOME_CODE',
					{ n },
				)
			}
		}
		throw new KoraError('Plain', 'OTHER_CODE')
		class B extends KoraError {
			constructor(message: string, code: 'FIRST_CODE' | 'SECOND_CODE') {
				super(message, code)
			}
		}`
		expect(koraErrorCodes(source)).toEqual(['SOME_CODE', 'OTHER_CODE', 'FIRST_CODE', 'SECOND_CODE'])
	})
})
