import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every source file reachable from `entry` through value imports, and the bare specifiers used. */
function closure(entry: string): { files: string[]; bare: string[] } {
	const seen = new Set<string>()
	const bare = new Set<string>()
	const visit = (file: string): void => {
		if (seen.has(file)) return
		seen.add(file)
		const source = readFileSync(file, 'utf8')
		const pattern = /^(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm
		for (const match of source.matchAll(pattern)) {
			if (match[1] !== undefined || match[2] === undefined) continue
			if (match[2].startsWith('.')) {
				const base = resolve(dirname(file), match[2])
				const found = [`${base}.ts`, join(base, 'index.ts')].find(existsSync)
				if (found) visit(found)
			} else {
				bare.add(match[2])
			}
		}
	}
	visit(entry)
	return { files: [...seen].map((file) => file.slice(__dirname.length + 1)), bare: [...bare] }
}

describe('@korajs/sync/lite (first-visit parity, S4a)', () => {
	const { files, bare } = closure(join(__dirname, 'lite.ts'))

	it('reaches only the lite entry of @korajs/core', () => {
		expect(bare).toEqual(['@korajs/core/lite'])
	})

	it('stays a handful of small files, not the runtime', () => {
		expect(files.length).toBeLessThan(12)
		expect(files.filter((file) => /adapters|sqlite|worker|engine|transport/.test(file))).toEqual([])
	})
})
