import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Template breakages found by scaffolding, installing, building and starting every
 * template from the local packages (Phase 4 ten-minute check).
 */
const templatesDir = resolve(__dirname, '../../templates')
const templates = readdirSync(templatesDir)

function manifest(template: string): {
	scripts?: Record<string, string>
	devDependencies?: Record<string, string>
	dependencies?: Record<string, string>
} {
	const raw = readFileSync(join(templatesDir, template, 'package.json.hbs'), 'utf-8')
	return JSON.parse(raw.replace(/\{\{\w+\}\}/g, '0.0.0'))
}

describe('bundled template manifests', () => {
	test.each(templates)('%s: `kora dev` can load its kora.config.ts (tsx installed)', (template) => {
		if (!existsSync(join(templatesDir, template, 'kora.config.ts'))) return
		const pkg = manifest(template)
		expect(pkg.devDependencies?.tsx ?? pkg.dependencies?.tsx).toBeDefined()
	})

	test.each(templates)('%s: @lucide/svelte is pinned to a published range', (template) => {
		const range = manifest(template).dependencies?.['@lucide/svelte']
		// @lucide/svelte's first stable release is 0.479.0; ^0.468.0 matches nothing.
		if (range) expect(range).not.toBe('^0.468.0')
	})

	test.each(templates.filter((t) => t.startsWith('svelte')))(
		'%s: a $state rune that is reassigned is declared with let',
		(template) => {
			const app = readFileSync(join(templatesDir, template, 'src/App.svelte'), 'utf-8')
			for (const [, name] of app.matchAll(/const (\w+) = \$state/g)) {
				expect(app, `${template}: ${name}`).not.toMatch(new RegExp(`\\(${name} = `))
			}
		},
	)

	test.each(templates)('%s: every VITE_ env var the source reads is typed', (template) => {
		const dir = join(templatesDir, template, 'src')
		const envFile = join(dir, 'vite-env.d.ts')
		if (!existsSync(envFile)) return
		const typed = readFileSync(envFile, 'utf-8')
		const read = new Set<string>()
		const walk = (d: string): void => {
			for (const entry of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, entry.name)
				if (entry.isDirectory()) walk(p)
				else if (/\.(ts|tsx|svelte|vue)$/.test(entry.name)) {
					for (const m of readFileSync(p, 'utf-8').matchAll(/import\.meta\.env\.(VITE_\w+)/g)) {
						read.add(m[1] as string)
					}
				}
			}
		}
		walk(dir)
		for (const name of read) expect(typed, `${template}: ${name}`).toContain(name)
	})
})

describe('flagship template (react-tailwind-sync, the --yes default) is on the typed path', () => {
	const src = join(templatesDir, 'react-tailwind-sync', 'src')

	test('hooks come from createKoraHooks<typeof app>() bound to the app', () => {
		const kora = readFileSync(join(src, 'kora.ts'), 'utf-8')
		expect(kora).toMatch(/createKoraHooks<typeof app>\(\)/)
		expect(kora).toMatch(/from 'korajs\/react'/)
	})

	test('no module reaches for the untyped hooks or CollectionAccessor', () => {
		const files = [
			'App.tsx',
			'main.tsx',
			'modules/todos/useTodos.ts',
			'modules/todos/todo.queries.ts',
			'modules/todos/todo.mutations.ts',
		]
		const untypedHook =
			/import \{[^}]*\b(useCollection|useQuery|useMutation|useSyncStatus)\b[^}]*\} from '@korajs\/react'/
		for (const file of files) {
			const text = readFileSync(join(src, file), 'utf-8')
			expect(text, file).not.toMatch(/\bCollectionAccessor\b/)
			expect(text, file).not.toMatch(untypedHook)
		}
	})
})
