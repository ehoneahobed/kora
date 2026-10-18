import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/**
 * A fold plan change (new transforms) re-folds every record from its log. During a
 * rolling deploy an instance still running the old plan may write meanwhile: the record
 * it folds with the old plan must still end up folded with the new one, whether it wrote
 * before the re-fold reached the record or after. Postgres runs with KORA_PG_TEST_URL.
 */
import type { Operation, OperationTransform } from '@korajs/core'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'
import { createSqliteServerStore } from './sqlite-server-store'

const schema = defineSchema({
	version: 2,
	collections: { docs: { fields: { title: t.string() } } },
})

const keep: OperationTransform = {
	fromVersion: 1,
	toVersion: 2,
	transform: (operation) => ({ ...operation, schemaVersion: 2 }),
}

/** The new plan: titles written under version 1 read in upper case. */
const shout: OperationTransform = {
	fromVersion: 1,
	toVersion: 2,
	transform: (operation) =>
		operation.data && typeof operation.data.title === 'string'
			? {
					...operation,
					schemaVersion: 2,
					data: { ...operation.data, title: operation.data.title.toUpperCase() },
				}
			: { ...operation, schemaVersion: 2 },
}

let seq = 0
function op(input: Partial<Operation> & Pick<Operation, 'recordId' | 'data'>): Operation {
	seq += 1
	return {
		id: `op-${seq}-${Math.random().toString(36).slice(2)}`,
		nodeId: 'device',
		type: 'insert',
		collection: 'docs',
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: 'device' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...input,
	}
}

const PG_URL = process.env.KORA_PG_TEST_URL
const clients: ReturnType<typeof postgres>[] = []

interface Executes {
	execute: (query: unknown) => Promise<unknown>
}

/** The SQL text of a drizzle query (enough to recognize one). */
function textOf(query: unknown): string {
	const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
	return chunks
		.map((chunk) => {
			const value = (chunk as { value?: unknown }).value
			return Array.isArray(value) ? value.join('') : ''
		})
		.join('')
}

async function twoInstances(): Promise<[PostgresServerStore, PostgresServerStore]> {
	const name = `kora_refold_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
	const admin = postgres(PG_URL ?? '', { max: 1 })
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	await admin.end()
	const make = async (instance: string): Promise<PostgresServerStore> => {
		const client = postgres(PG_URL ?? '', { max: 4, connection: { search_path: name } })
		clients.push(client)
		const store = new PostgresServerStore(drizzle(client), 'server-node', undefined, {
			instanceId: instance,
		})
		await store.setSchema(schema, { operationTransforms: [keep] })
		return store
	}
	const a = await make('a')
	return [a, await make('b')]
}

async function titleOf(store: PostgresServerStore, id: string): Promise<unknown> {
	const db = (store as unknown as { db: Executes }).db
	const rows = (await db.execute(sql`SELECT title FROM docs WHERE id = ${id}`)) as {
		title: unknown
	}[]
	return rows[0]?.title
}

describe.skipIf(!PG_URL)('postgres: a re-fold during a rolling deploy', () => {
	afterAll(async () => {
		await Promise.all(clients.map((client) => client.end()))
	})

	test('a write by an old-plan instance before the re-fold reaches the record', async () => {
		const [a, b] = await twoInstances()
		await a.applyRemoteOperation(op({ recordId: 'r1', data: { title: 'a' } }))
		// a's re-fold stops before its first page, after the new plan is recorded.
		const db = (a as unknown as { db: Executes }).db
		const execute = db.execute.bind(db)
		let release = (): void => {}
		const paused = new Promise<void>((resolve) => {
			release = resolve
		})
		let reached = (): void => {}
		const atScan = new Promise<void>((resolve) => {
			reached = resolve
		})
		let first = true
		db.execute = async (query: unknown) => {
			if (first && textOf(query).includes('WITH recs AS')) {
				first = false
				reached()
				await paused
			}
			return execute(query)
		}
		const refold = a.setOperationTransforms([shout])
		await atScan
		// b still folds with the old plan.
		await b.applyRemoteOperation(
			op({
				type: 'update',
				recordId: 'r1',
				data: { title: 'b' },
				previousData: { title: 'a' },
			}),
		)
		release()
		await refold
		expect(await titleOf(a, 'r1')).toBe('B')
	})

	test('a write by an old-plan instance after the re-fold passed the record', async () => {
		const [a, b] = await twoInstances()
		await a.applyRemoteOperation(op({ recordId: 'r2', data: { title: 'a' } }))
		await a.setOperationTransforms([shout])
		expect(await titleOf(a, 'r2')).toBe('A')
		await b.applyRemoteOperation(
			op({
				type: 'update',
				recordId: 'r2',
				data: { title: 'b' },
				previousData: { title: 'a' },
			}),
		)
		// The instance on the recorded plan folds it again (the server's delivery poll).
		await a.refoldOutdatedRecords()
		expect(await titleOf(a, 'r2')).toBe('B')
		// The old-plan instance never undoes it (its plan is not the recorded one).
		await b.refoldOutdatedRecords()
		expect(await titleOf(a, 'r2')).toBe('B')
	})
})

const accessSchema = defineSchema({
	version: 2,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
		},
	},
})

/** The new plan: version 1 viewers became editors. */
const promote: OperationTransform = {
	fromVersion: 1,
	toVersion: 2,
	transform: (operation) =>
		operation.collection === 'members' && operation.data?.role === 'view'
			? { ...operation, schemaVersion: 2, data: { ...operation.data, role: 'edit' } }
			: { ...operation, schemaVersion: 2 },
}

describe.skipIf(!PG_URL)('postgres: a record the new plan cannot fold', () => {
	test('does not keep the other outdated records back', async () => {
		const [a, b] = await twoInstances()
		await a.applyRemoteOperation(op({ recordId: 'ok', data: { title: 'a' } }))
		await a.applyRemoteOperation(op({ recordId: 'bad', data: { title: 'a' } }))
		const picky: OperationTransform = {
			fromVersion: 1,
			toVersion: 2,
			transform: (operation) => {
				if (operation.data?.title === 'boom') throw new Error('cannot read boom')
				return shout.transform(operation)
			},
		}
		await a.setOperationTransforms([picky])
		for (const [recordId, title] of [
			['ok', 'b'],
			['bad', 'boom'],
		] as const) {
			await b.applyRemoteOperation(
				op({ type: 'update', recordId, data: { title }, previousData: { title: 'a' } }),
			)
		}
		// The failure is reported (so the server keeps checking); the other record is done.
		await expect(a.refoldOutdatedRecords()).rejects.toMatchObject({ code: 'REFOLD_INCOMPLETE' })
		expect(await titleOf(a, 'ok')).toBe('B')
	})
})

describe.skipIf(!PG_URL)('postgres: re-folded memberships', () => {
	test('the membership index follows a re-fold of records an old-plan instance wrote', async () => {
		const name = `kora_refold_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		const admin = postgres(PG_URL ?? '', { max: 1 })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		await admin.end()
		const make = async (instance: string): Promise<PostgresServerStore> => {
			const client = postgres(PG_URL ?? '', { max: 4, connection: { search_path: name } })
			clients.push(client)
			const store = new PostgresServerStore(drizzle(client), 'server-node', undefined, {
				instanceId: instance,
			})
			await store.setSchema(accessSchema, { operationTransforms: [keep] })
			return store
		}
		const a = await make('a')
		const b = await make('b')
		await a.setOperationTransforms([promote])
		// b (old plan) indexes a viewer.
		await b.applyRemoteOperation(
			op({
				collection: 'members',
				recordId: 'm1',
				data: { userId: 'u', group: 'documents:d', role: 'view' },
			}),
		)
		expect((await a.getMembershipIntervals('u'))[0]?.role).toBe('view')
		expect(await a.refoldOutdatedRecords()).toBe(1)
		expect((await a.getMembershipIntervals('u'))[0]?.role).toBe('edit')
		expect(a.isAccessIndexReady()).toBe(true)
	})
})

describe('sqlite: a re-fold during a rolling deploy (processes sharing one file)', () => {
	test('a write by an old-plan process after the re-fold is folded again', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-refold-'))
		const filename = join(dir, 'server.db')
		const a = createSqliteServerStore({ filename })
		const b = createSqliteServerStore({ filename })
		try {
			await a.setSchema(schema, { operationTransforms: [keep] })
			await b.setSchema(schema, { operationTransforms: [keep] })
			await a.applyRemoteOperation(op({ recordId: 's1', data: { title: 'a' } }))
			await a.setOperationTransforms([shout])
			await b.applyRemoteOperation(
				op({
					type: 'update',
					recordId: 's1',
					data: { title: 'b' },
					previousData: { title: 'a' },
				}),
			)
			const db = (a as unknown as { db: { all: (q: unknown) => { title: unknown }[] } }).db
			const title = (): unknown => db.all(sql`SELECT title FROM docs WHERE id = 's1'`)[0]?.title
			expect(title()).toBe('b')
			expect(await b.refoldOutdatedRecords()).toBe(0)
			expect(await a.refoldOutdatedRecords()).toBe(1)
			expect(title()).toBe('B')
		} finally {
			await a.close()
			await b.close()
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
