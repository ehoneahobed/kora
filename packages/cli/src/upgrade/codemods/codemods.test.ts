import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { defaultedNullChecksCodemod } from './defaulted-null-checks'
import { jsonStringValuesCodemod } from './json-string-values'
import { protobufSerializerCodemod } from './protobuf-serializer'
import { CODEMODS, applyCodemodEdits, codemodApplies, runCodemods } from './registry'
import { readSourceFiles } from './source-files'
import type { Codemod, CodemodContext, SourceFile } from './types'

function context(files: SourceFile[], overrides: Partial<CodemodContext> = {}): CodemodContext {
	return {
		projectRoot: '/p',
		files,
		fromVersion: '1.0.0-beta.12',
		toVersion: '1.0.0-beta.15',
		...overrides,
	}
}

const SCHEMA: SourceFile = {
	path: 'src/schema.ts',
	text: [
		"import { defineSchema, t } from 'korajs'",
		'export default defineSchema({',
		'  version: 2,',
		'  collections: {',
		'    forms: {',
		'      fields: {',
		'        title: t.string(),',
		"        status: t.enum(['draft', 'live']).default('draft'),",
		'        fields: t.json(),',
		'        settings: t.object({}).optional(),',
		'      },',
		'    },',
		'  },',
		'})',
	].join('\n'),
}

describe('protobuf serializer codemod', () => {
	it('flags the removed serializer and the explicit opt-in, skipping imports and comments', () => {
		const result = protobufSerializerCodemod.run(
			context([
				{
					path: 'src/sync.ts',
					text: [
						"import { DynamicProtobufSerializer, ProtobufMessageSerializer } from '@korajs/sync'",
						'// ProtobufMessageSerializer was used here before',
						'const a = new DynamicProtobufSerializer()',
						'const b = new ProtobufMessageSerializer()',
						'const c = 1',
					].join('\n'),
				},
			]),
		)
		expect(result.edits).toEqual([])
		expect(result.findings.map((f) => [f.line, f.severity])).toEqual([
			[3, 'warn'],
			[4, 'warn'],
		])
		expect(result.findings[0]?.message).toContain('removed in beta.13')
		expect(result.findings[1]?.message).toContain('both ends')
	})

	it('is quiet for code that does not mention protobuf', () => {
		expect(
			protobufSerializerCodemod.run(context([{ path: 'a.ts', text: 'const x = 1' }])).findings,
		).toEqual([])
	})
})

describe('json string values codemod', () => {
	it('flags JSON.stringify writes and JSON.parse reads of json/object schema fields only', () => {
		const result = jsonStringValuesCodemod.run(
			context([
				SCHEMA,
				{
					path: 'src/form.ts',
					text: [
						'await app.forms.insert({ title: "a", fields: JSON.stringify(fields) })',
						'const parsed = JSON.parse(form.fields)',
						'const ok = JSON.parse(form.title)',
						'await app.forms.update(id, { title: JSON.stringify(x) })',
						'await app.forms.update(id, { settings: JSON.stringify({}) })',
					].join('\n'),
				},
			]),
		)
		expect(result.findings.map((f) => [f.file, f.line, f.severity])).toEqual([
			['src/form.ts', 1, 'warn'],
			['src/form.ts', 2, 'info'],
			['src/form.ts', 5, 'warn'],
		])
		expect(result.findings[0]?.message).toContain('findJsonStringValues')
	})

	it('reports nothing when the schema has no json fields', () => {
		const files: SourceFile[] = [{ path: 'a.ts', text: 'const x = { fields: JSON.stringify(1) }' }]
		expect(jsonStringValuesCodemod.run(context(files)).findings).toEqual([])
	})
})

describe('defaulted null checks codemod', () => {
	it('flags null tests and ?? fallbacks on defaulted fields as info', () => {
		const result = defaultedNullChecksCodemod.run(
			context([
				SCHEMA,
				{
					path: 'src/list.ts',
					text: [
						'const drafts = forms.filter((f) => f.status === null)',
						"const label = form.status ?? 'unknown'",
						'const missing = null !== form.status',
						'const fine = form.title === null',
						'// form.status === null in a comment',
					].join('\n'),
				},
			]),
		)
		expect(result.findings.map((f) => [f.line, f.severity])).toEqual([
			[1, 'info'],
			[2, 'info'],
			[3, 'info'],
		])
		expect(result.findings[0]?.message).toContain('schema default')
	})
})

describe('registry', () => {
	const sample: Codemod = {
		id: 'sample',
		title: 'Sample',
		introducedIn: '1.0.0-beta.13',
		docs: 'https://example.com',
		run: () => ({ findings: [], edits: [] }),
	}

	it('lists the built-in codemods with unique ids and documentation links', () => {
		const ids = CODEMODS.map((codemod) => codemod.id)
		expect(new Set(ids).size).toBe(ids.length)
		for (const codemod of CODEMODS)
			expect(codemod.docs).toMatch(/^https:\/\/korajs\.dev\/guide\/[a-z0-9-]+$/)
	})

	it('runs a codemod only when the upgrade crosses its release', () => {
		expect(codemodApplies(sample, '1.0.0-beta.12', '1.0.0-beta.15')).toBe(true)
		expect(codemodApplies(sample, '1.0.0-beta.13', '1.0.0-beta.15')).toBe(false)
		expect(codemodApplies(sample, '1.0.0-beta.12', '1.0.0-beta.12')).toBe(false)
		expect(codemodApplies(sample, null, '1.0.0-beta.15')).toBe(true)
	})

	it('runCodemods skips codemods that do not apply', () => {
		const summaries = runCodemods(context([], { fromVersion: '1.0.0-beta.14' }), [sample])
		expect(summaries).toEqual([])
	})
})

describe('applyCodemodEdits', () => {
	const temps: Array<{ cleanup: () => Promise<void> }> = []
	afterEach(async () => {
		for (const temp of temps) await temp.cleanup()
		temps.length = 0
	})

	it('applies edits from the end, and skips overlapping or stale files with a report', async () => {
		const dir = await createTempDir()
		temps.push(dir)
		await writeFile(join(dir.path, 'a.ts'), 'one two three')
		await writeFile(join(dir.path, 'b.ts'), 'abcdef')
		await writeFile(join(dir.path, 'c.ts'), 'stale')
		const files: SourceFile[] = [
			{ path: 'a.ts', text: 'one two three' },
			{ path: 'b.ts', text: 'abcdef' },
			{ path: 'c.ts', text: 'older text' },
		]
		const result = await applyCodemodEdits(dir.path, files, [
			{ file: 'a.ts', start: 0, end: 3, replacement: '1' },
			{ file: 'a.ts', start: 8, end: 13, replacement: '3' },
			{ file: 'b.ts', start: 0, end: 4, replacement: 'X' },
			{ file: 'b.ts', start: 2, end: 6, replacement: 'Y' },
			{ file: 'c.ts', start: 0, end: 1, replacement: 'Z' },
		])
		expect(result).toEqual({ written: ['a.ts'], skipped: ['b.ts', 'c.ts'] })
		expect(await readFile(join(dir.path, 'a.ts'), 'utf-8')).toBe('1 two 3')
		expect(await readFile(join(dir.path, 'b.ts'), 'utf-8')).toBe('abcdef')
	})
})

describe('readSourceFiles', () => {
	const temps: Array<{ cleanup: () => Promise<void> }> = []
	afterEach(async () => {
		for (const temp of temps) await temp.cleanup()
		temps.length = 0
	})

	it('reads source files in stable order and skips node_modules, build output and declarations', async () => {
		const dir = await createTempDir()
		temps.push(dir)
		const { mkdir } = await import('node:fs/promises')
		for (const sub of ['src', 'node_modules/x', 'dist']) {
			await mkdir(join(dir.path, sub), { recursive: true })
		}
		await writeFile(join(dir.path, 'src', 'b.ts'), 'b')
		await writeFile(join(dir.path, 'src', 'a.tsx'), 'a')
		await writeFile(join(dir.path, 'src', 'types.d.ts'), 'd')
		await writeFile(join(dir.path, 'src', 'notes.md'), 'm')
		await writeFile(join(dir.path, 'node_modules/x/index.js'), 'n')
		await writeFile(join(dir.path, 'dist', 'out.js'), 'o')
		await writeFile(join(dir.path, 'server.ts'), 's')
		const files = await readSourceFiles(dir.path)
		expect(files.map((file) => file.path)).toEqual(['server.ts', 'src/a.tsx', 'src/b.ts'])
	})
})
