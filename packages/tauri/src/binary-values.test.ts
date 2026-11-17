import { fc, test as propTest } from '@fast-check/vitest'
import { base64ToBytes, bytesToBase64, defineSchema, t } from '@korajs/core'
import { Store } from '@korajs/store'
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { type InvokeFn, TauriSqliteAdapter } from './tauri-sqlite-adapter'

/**
 * Binary values over the Tauri IPC boundary. `invoke` carries its arguments and results as
 * JSON, so a `Uint8Array` must travel in a tagged form (`{ $koraBytes: base64 }`) both ways:
 * otherwise it arrives as `{"0":..}` and is stored as JSON text, and a BLOB comes back as
 * text the store cannot decode (rich text breaks on Tauri).
 *
 * The invoke below is faithful to the plugin's contract: arguments cross JSON, parameters are
 * bound by the plugin's rules (booleans as 0/1, a tagged value as a BLOB, other objects as
 * JSON text), and BLOB columns come back tagged.
 */
function jsonBoundaryInvoke(): InvokeFn & { sent: unknown[][] } {
	const db = new Database(':memory:')
	const sent: unknown[][] = []
	const bind = (value: unknown): unknown => {
		if (value === null || value === undefined) return null
		if (typeof value === 'boolean') return value ? 1 : 0
		if (typeof value === 'number' || typeof value === 'string') return value
		if (
			typeof value === 'object' &&
			value !== null &&
			Object.keys(value).length === 1 &&
			typeof (value as { $koraBytes?: unknown }).$koraBytes === 'string'
		) {
			return Buffer.from(base64ToBytes((value as { $koraBytes: string }).$koraBytes))
		}
		return JSON.stringify(value)
	}
	const fromColumn = (value: unknown): unknown =>
		Buffer.isBuffer(value) ? { $koraBytes: bytesToBase64(new Uint8Array(value)) } : value
	const invoke = (async <T>(cmd: string, rawArgs?: Record<string, unknown>): Promise<T> => {
		const args = JSON.parse(JSON.stringify(rawArgs ?? {})) as Record<string, unknown>
		const command = cmd.replace('plugin:kora-sqlite|', '')
		const params = ((args.params as unknown[] | undefined) ?? []).map(bind)
		if (command === 'execute' || command === 'query') sent.push(args.params as unknown[])
		let result: unknown
		switch (command) {
			case 'open':
				for (const sql of args.statements as string[]) {
					try {
						db.exec(sql.replace('--kora:safe-alter\n', ''))
					} catch (error) {
						if (!String((error as Error).message).includes('duplicate column name')) throw error
					}
				}
				break
			case 'close':
				break
			case 'execute':
				db.prepare(args.sql as string).run(...params)
				break
			case 'query':
				result = (db.prepare(args.sql as string).all(...params) as Record<string, unknown>[]).map(
					(row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fromColumn(v)])),
				)
				break
			case 'migrate':
				for (const sql of args.statements as string[]) db.exec(sql)
				break
			default:
				throw new Error(`Unknown command: ${command}`)
		}
		// Results cross JSON too.
		return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as T
	}) as InvokeFn & { sent: unknown[][] }
	invoke.sent = sent
	return invoke
}

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), body: t.richtext().optional() } } },
})

async function openAdapter() {
	const invoke = jsonBoundaryInvoke()
	const adapter = new TauriSqliteAdapter({ path: 'bin.db', invoke })
	await adapter.open(schema)
	await adapter.execute('CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, data BLOB)')
	return { adapter, invoke }
}

describe('binary values through the Tauri plugin', () => {
	test('a Uint8Array parameter is sent in the tagged form', async () => {
		const { adapter, invoke } = await openAdapter()
		await adapter.execute('INSERT INTO blobs (id, data) VALUES (?, ?)', [
			1,
			new Uint8Array([0, 1, 255]),
		])
		expect(invoke.sent.at(-1)).toEqual([
			1,
			{ $koraBytes: bytesToBase64(new Uint8Array([0, 1, 255])) },
		])
	})

	test('a BLOB column comes back as a Uint8Array equal to what was written', async () => {
		const { adapter } = await openAdapter()
		const bytes = new Uint8Array([0, 1, 2, 254, 255])
		await adapter.execute('INSERT INTO blobs (id, data) VALUES (?, ?)', [1, bytes])
		const rows = await adapter.query<{ data: unknown }>('SELECT data FROM blobs WHERE id = 1')
		expect(rows[0]?.data).toBeInstanceOf(Uint8Array)
		expect(Array.from(rows[0]?.data as Uint8Array)).toEqual(Array.from(bytes))
	})

	propTest.prop([fc.uint8Array({ minLength: 0, maxLength: 4096 })], { numRuns: 50 })(
		'any byte array round-trips byte-exact, inside a transaction too',
		async (bytes) => {
			const { adapter } = await openAdapter()
			await adapter.transaction(async (tx) => {
				await tx.execute('INSERT INTO blobs (id, data) VALUES (?, ?)', [1, bytes])
				const inside = await tx.query<{ data: Uint8Array }>('SELECT data FROM blobs WHERE id = 1')
				expect(Array.from(inside[0]?.data ?? [])).toEqual(Array.from(bytes))
			})
			const rows = await adapter.query<{ data: Uint8Array }>('SELECT data FROM blobs WHERE id = 1')
			expect(rows[0]?.data).toBeInstanceOf(Uint8Array)
			expect(Array.from(rows[0]?.data ?? [])).toEqual(Array.from(bytes))
		},
	)

	test('a rich text field round-trips through a Store on the Tauri adapter', async () => {
		const invoke = jsonBoundaryInvoke()
		const adapter = new TauriSqliteAdapter({ path: 'store.db', invoke })
		const store = new Store({ schema, adapter, nodeId: 'device' })
		await store.open()
		const note = await store.collection('notes').insert({ title: 'n', body: 'hello rich text' })
		const read = await store.collection('notes').findById(note.id)
		expect(read?.body).toBe('hello rich text')
		await store.close()
	})
})
