/**
 * A server backup's version vector must claim exactly the operations the backup holds. A
 * vector ahead of its rows is written by a replace restore, and a device compares it with its
 * own log to decide what to upload again: an operation the vector claims but the rows lack is
 * never re-uploaded, so it is lost.
 *
 * An operation committed while the export runs (after its row read) reproduces it: here it is
 * committed from inside the export's next read, as a concurrent write would land.
 */
import { defineSchema } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { dropTrackedPgSchemas, trackPgSchema } from '../../tests/fixtures/pg-test-schemas'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import { parseServerBackup } from './server-backup'
import type { ServerStore } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'

afterAll(dropTrackedPgSchemas)
const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
}) as unknown as SchemaDefinition

const op = (seq: number): Operation => ({
	id: `phone-op-${seq}`,
	nodeId: 'phone',
	type: 'insert',
	collection: 'todos',
	recordId: `r${seq}`,
	data: { title: `todo ${seq}` },
	previousData: null,
	timestamp: { wallTime: 1_790_000_000_000 + seq, logical: 0, nodeId: 'phone' },
	sequenceNumber: seq,
	causalDeps: [],
	schemaVersion: 1,
})

type Opened = { store: ServerStore; end: () => Promise<void> }
let schemas = 0
const makers: Array<[string, () => Promise<Opened>]> = [
	['memory', async () => ({ store: new MemoryServerStore(), end: async () => {} })],
	['sqlite', async () => ({ store: createSqliteServerStore({}), end: async () => {} })],
]
if (PG_URL) {
	makers.push([
		'postgres',
		async () => {
			const name = `kora_backup_vector_${process.pid}_${schemas++}`
			const admin = postgres(PG_URL, { max: 1, onnotice: () => {} })
			await admin.unsafe(`CREATE SCHEMA ${name}`)
			trackPgSchema(name)
			await admin.end()
			const client = postgres(PG_URL, {
				max: 2,
				onnotice: () => {},
				connection: { search_path: name },
			})
			return {
				store: new PostgresServerStore(drizzle(client)),
				end: async () => {
					await client.end({ timeout: 5 })
				},
			}
		},
	])
}

describe.each(makers)('%s server store: a backup vector claims only its rows', (_kind, make) => {
	test('an operation committed during the export is neither in the vector nor lost on restore', async () => {
		const source = await make()
		const target = await make()
		try {
			await source.store.setSchema(schema)
			for (const seq of [1, 2])
				expect(await source.store.applyRemoteOperation(op(seq))).toBe('applied')

			// The export's read after its row select: a write commits there.
			const store = source.store as ServerStore & {
				listEncryptionKeyRecords: (owner?: string) => Promise<unknown[]>
			}
			const read = store.listEncryptionKeyRecords.bind(store)
			let committed = false
			store.listEncryptionKeyRecords = async (owner?: string) => {
				if (!committed) {
					committed = true
					expect(await source.store.applyRemoteOperation(op(3))).toBe('applied')
				}
				return read(owner)
			}
			const backup = await source.store.exportBackup()
			const parsed = parseServerBackup(backup)
			const highestRow = Math.max(
				0,
				...parsed.operations.filter((o) => o.nodeId === 'phone').map((o) => o.sequenceNumber),
			)
			expect(parsed.versionVector.get('phone') ?? 0).toBe(highestRow)

			// Restored, the vector stays below every operation the backup lacks: the device that
			// wrote them sends them again.
			await target.store.setSchema(schema)
			await target.store.importBackup(backup)
			const restored = target.store.getVersionVector().get('phone') ?? 0
			const missing = [1, 2, 3].filter(
				(seq) => !parsed.operations.some((o) => o.sequenceNumber === seq),
			)
			for (const seq of missing) expect(restored).toBeLessThan(seq)
			for (const seq of missing)
				expect(await target.store.applyRemoteOperation(op(seq))).toBe('applied')
			expect((await target.store.queryCollection('todos')).map((row) => row.id)).toEqual([
				'r1',
				'r2',
				'r3',
			])
		} finally {
			await source.store.close()
			await target.store.close()
			await source.end()
			await target.end()
		}
	})
})
