import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import {
	checkDuplicateSchemas,
	findSchemaDefinitions,
	groupDuplicateSchemas,
	scanSchemaDefinitions,
} from './schema-duplicates'

const CLIENT_SCHEMA = `
import { defineSchema, t } from 'korajs'

export default defineSchema({
	version: 3,
	collections: {
		forms: { fields: { title: t.string(), settings: t.json().optional() } },
		'form-responses': { fields: { formId: t.string() } },
		collaborators: { fields: { userId: t.string() }, indexes: ['userId'] },
	},
})
`

describe('findSchemaDefinitions', () => {
	it('lists top-level collection names, quoted and shorthand ones included', () => {
		const sites = findSchemaDefinitions(
			`import { forms } from './forms'
export const schema = defineSchema({ version: 1, collections: { forms, 'a-b': { fields: {} }, c() {} } })`,
			'src/schema.ts',
		)
		expect(sites).toEqual([{ file: 'src/schema.ts', line: 2, collections: ['forms', 'a-b', 'c'] }])
	})

	it('does not take nested keys (fields, indexes) for collections', () => {
		const [site] = findSchemaDefinitions(CLIENT_SCHEMA, 'a.ts')
		expect(site?.collections).toEqual(['forms', 'form-responses', 'collaborators'])
	})

	it('ignores comments, strings and imports that mention defineSchema', () => {
		const source = `
import { defineSchema } from 'korajs'
// defineSchema({ collections: { ghost: {} } })
/* defineSchema({ collections: { ghost2: {} } }) */
const doc = "defineSchema({ collections: { ghost3: {} } })"
const tpl = \`defineSchema({ collections: { ghost4: {} } })\`
export { defineSchema }
`
		expect(findSchemaDefinitions(source, 'x.ts')).toEqual([])
	})

	it('skips a call whose collections are not an object literal', () => {
		expect(
			findSchemaDefinitions('defineSchema({ version: 1, collections: shared })', 'x.ts'),
		).toEqual([])
		expect(findSchemaDefinitions('defineSchema(config)', 'x.ts')).toEqual([])
	})

	it('finds several calls in one file', () => {
		const sites = findSchemaDefinitions(
			'const a = defineSchema({ collections: { x: {} } })\nconst b = defineSchema({ collections: { y: {} } })',
			'x.ts',
		)
		expect(sites.map((s) => s.collections)).toEqual([['x'], ['y']])
	})
})

describe('groupDuplicateSchemas', () => {
	it('groups sites that share a name and leaves disjoint ones alone', () => {
		const groups = groupDuplicateSchemas([
			{ file: 'a.ts', line: 1, collections: ['x', 'y'] },
			{ file: 'b.ts', line: 1, collections: ['y', 'z'] },
			{ file: 'c.ts', line: 1, collections: ['other'] },
		])
		expect(groups).toHaveLength(1)
		expect(groups[0]?.shared).toEqual(['y'])
		expect(groups[0]?.sites.map((s) => s.file)).toEqual(['a.ts', 'b.ts'])
	})
})

describe('checkDuplicateSchemas', () => {
	const temps: Array<{ cleanup: () => Promise<void> }> = []
	afterEach(async () => {
		for (const temp of temps) await temp.cleanup()
		temps.length = 0
	})

	async function project(files: Record<string, string>): Promise<string> {
		const temp = await createTempDir()
		temps.push(temp)
		for (const [name, content] of Object.entries(files)) {
			const path = join(temp.path, name)
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, content)
		}
		return temp.path
	}

	it('warns with both paths for a koraforms-like client and server schema', async () => {
		const root = await project({
			'src/schema.ts': CLIENT_SCHEMA,
			'server/schema.ts': CLIENT_SCHEMA.replace('version: 3', 'version: 2'),
			'server/index.ts': "import schema from './schema'\nconsole.log(schema)",
		})
		const result = await checkDuplicateSchemas(root)
		expect(result.id).toBe('schema-duplicates')
		expect(result.status).toBe('warn')
		expect(result.message).toContain('src/schema.ts:4')
		expect(result.message).toContain('server/schema.ts:4')
		expect(result.message).toContain('forms, form-responses, collaborators')
		expect(result.fix).toContain(
			'import it in the client app, the sync server entry and kora.config.ts',
		)
	})

	it('passes for one schema module imported by client and server', async () => {
		const root = await project({
			'src/schema.ts': CLIENT_SCHEMA,
			'src/main.ts': "import schema from './schema'\nexport { schema }",
			'server.ts': "import schema from './src/schema'\nexport { schema }",
			'kora.config.ts': "export default { schema: './src/schema.ts' }",
		})
		const result = await checkDuplicateSchemas(root)
		expect(result.status).toBe('pass')
		expect(result.message).toContain('1 defineSchema() call(s)')
	})

	it('passes for two schemas that declare different collections', async () => {
		const root = await project({
			'src/schema.ts': CLIENT_SCHEMA,
			'tools/audit-schema.ts': 'export default defineSchema({ collections: { audit: {} } })',
		})
		expect((await checkDuplicateSchemas(root)).status).toBe('pass')
	})

	it('ignores node_modules, dist, fixtures, tests and declaration files', async () => {
		const root = await project({
			'src/schema.ts': CLIENT_SCHEMA,
			'node_modules/pkg/schema.js': CLIENT_SCHEMA,
			'dist/schema.js': CLIENT_SCHEMA,
			'tests/fixtures/schema.ts': CLIENT_SCHEMA,
			'src/schema.test.ts': CLIENT_SCHEMA,
			'src/schema.d.ts': CLIENT_SCHEMA,
		})
		const sites = await scanSchemaDefinitions(root)
		expect(sites.map((s) => s.file)).toEqual(['src/schema.ts'])
		expect((await checkDuplicateSchemas(root)).status).toBe('pass')
	})

	it('passes with a message when there is no defineSchema call at all', async () => {
		const root = await project({ 'src/main.ts': 'export {}' })
		const result = await checkDuplicateSchemas(root)
		expect(result.status).toBe('pass')
		expect(result.message).toContain('No defineSchema()')
	})

	it('reports a scan failure as a skip, never an error', async () => {
		const result = await checkDuplicateSchemas('/x', async () => {
			throw new Error('boom')
		})
		expect(result.status).toBe('skip')
		expect(result.message).toContain('boom')
	})
})
