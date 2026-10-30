import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * D6, one schema on client and server: every bundled template declares its schema once
 * (`src/schema.ts`) and the client, the sync server entry and `kora.config.ts` all point
 * at that module. A second `defineSchema` is how koraforms ended up with a client schema
 * and a server schema that drifted apart.
 */
const templatesDir = resolve(__dirname, '../../templates')
const templates = readdirSync(templatesDir)
const SCHEMA_MODULE = 'src/schema.ts'

function sourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'src-tauri') continue
		const path = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...sourceFiles(path))
		else if (/\.(ts|tsx|js|svelte|vue)$/.test(entry.name)) out.push(path)
	}
	return out
}

describe('bundled templates share one schema module', () => {
	test('there are 13 templates', () => {
		expect(templates).toHaveLength(13)
	})

	test.each(templates)('%s: defineSchema is called exactly once, in src/schema.ts', (template) => {
		const root = join(templatesDir, template)
		const callers = sourceFiles(root)
			.filter((file) => /\bdefineSchema\s*\(/.test(readFileSync(file, 'utf-8')))
			.map((file) => file.slice(root.length + 1).replaceAll('\\', '/'))
		expect(callers).toEqual([SCHEMA_MODULE])
	})

	test.each(templates)('%s: kora.config.ts names the shared schema module', (template) => {
		const config = readFileSync(join(templatesDir, template, 'kora.config.ts'), 'utf-8')
		expect(config).toMatch(/schema:\s*['"]\.\/src\/schema(\.ts)?['"]/)
	})

	test.each(templates)('%s: the client entry imports the shared schema module', (template) => {
		const root = join(templatesDir, template)
		const importers = sourceFiles(join(root, 'src')).filter((file) =>
			/from\s+['"]\.\/schema['"]/.test(readFileSync(file, 'utf-8')),
		)
		expect(importers.length, `${template}: nothing under src/ imports ./schema`).toBeGreaterThan(0)
	})

	test.each(templates.filter((t) => existsSync(join(templatesDir, t, 'server.ts'))))(
		'%s: the sync server imports the same schema module as the client',
		(template) => {
			const server = readFileSync(join(templatesDir, template, 'server.ts'), 'utf-8')
			expect(server).toMatch(/import\s+schema\s+from\s+['"]\.\/src\/schema['"]/)
		},
	)
})
