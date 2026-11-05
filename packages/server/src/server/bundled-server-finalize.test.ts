import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, test } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..', '..')
const SERVER_INDEX = join(HERE, '..', 'index.ts')

/**
 * A server bundled the way a deployed one is (NODE_ENV=production, workspace packages inlined,
 * `sideEffects: false` honoured), fed a schema from the lite entry that was defined before the
 * server's modules evaluated. Sync rules and access rules must be present when it runs. The
 * path where registration never happens at all is covered by the unit test in
 * kora-sync-server.test.ts.
 */
describe('a production bundle of the sync server', () => {
	test('finalizes a lite schema (sync rules, migrations, access rules) at construction', async () => {
		const dir = mkdtempSync(join(PACKAGE_ROOT, 'node_modules', '.kora-bundled-server-'))
		try {
			// The schema module is evaluated before the server's modules (import order), the way an
			// app's schema file is: nothing has registered a finalizer when defineSchema runs.
			writeFileSync(
				join(dir, 'schema.ts'),
				`import { defineSchema, t } from '@korajs/core/lite'
export const schema = defineSchema({
  version: 1,
  access: { memberships: 'members', roles: ['view', 'edit'] },
  collections: {
    members: { fields: { userId: t.string(), group: t.string(), role: t.enum(['view', 'edit']) } },
    notes: { fields: { title: t.string(), userId: t.string() } },
  },
  sync: { notes: { where: { userId: true } } },
})
`,
			)
			writeFileSync(
				join(dir, 'entry.ts'),
				`import { schema } from './schema'
import { KoraSyncServer, MemoryServerStore } from ${JSON.stringify(SERVER_INDEX)}
const store = new MemoryServerStore('server-1')
store.getSchema = () => schema
new KoraSyncServer({ store })
const json = JSON.parse(JSON.stringify(schema))
console.log(JSON.stringify({
  access: schema.access !== undefined,
  sync: json.sync !== undefined,
  unfinalized: json.unfinalized === true,
}))
`,
			)
			const result = await build({
				entryPoints: [join(dir, 'entry.ts')],
				bundle: true,
				format: 'esm',
				platform: 'node',
				write: false,
				// Workspace packages are bundled so the production define reaches their registration code.
				external: ['ws', 'better-sqlite3', 'postgres', 'drizzle-orm', 'yjs'],
				logLevel: 'silent',
				define: { 'process.env.NODE_ENV': '"production"' },
			})
			const file = join(dir, 'server.mjs')
			writeFileSync(file, result.outputFiles[0]?.text ?? '')
			const out = execFileSync(process.execPath, [file], { encoding: 'utf8' })
			expect(JSON.parse(out.trim().split('\n').pop() ?? '{}')).toEqual({
				access: true,
				sync: true,
				unfinalized: false,
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
