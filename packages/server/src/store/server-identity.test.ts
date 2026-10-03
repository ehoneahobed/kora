import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, deriveSideEffectOpId, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import {
	SERVER_LEGACY_AUTHORITY_KEY,
	SERVER_LEGACY_SCAN_KEY,
	ServerAuthoritySet,
	ServerIdentityError,
	authoritativeStampOpIds,
	deriveKeyedServerOpId,
	parseIdentityOptions,
} from './server-identity'
import { createSqliteServerStore } from './sqlite-server-store'

const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				status: t.string().merge('server-authoritative').optional(),
			},
		},
	},
}) as unknown as SchemaDefinition

let seq = 0
function op(nodeId: string, wall: number, partial: Partial<Operation>): Operation {
	seq += 1
	return {
		id: `id-${nodeId}-${seq}`,
		nodeId,
		type: 'insert',
		collection: 'items',
		recordId: 'r1',
		data: {},
		previousData: null,
		timestamp: { wallTime: wall, logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
}

describe('identity options', () => {
	test('a plain nodeId is a legacy authority; a kora:server: id is verbatim; other kora: ids are refused', () => {
		expect(parseIdentityOptions({ nodeId: 'server-1' })).toMatchObject({
			verbatimNodeId: null,
			legacyNodeId: 'server-1',
			explicitAuthorities: ['server-1'],
		})
		expect(parseIdentityOptions({ nodeId: 'kora:server:d:i' }).verbatimNodeId).toBe(
			'kora:server:d:i',
		)
		expect(() => parseIdentityOptions({ nodeId: 'kora:scope-entry' })).toThrow(ServerIdentityError)
		expect(() => parseIdentityOptions({ instanceId: 'a:b' })).toThrow(ServerIdentityError)
		expect(
			parseIdentityOptions({ authoritativeNodeIds: ['x', 'kora:evil'] }).explicitAuthorities,
		).toEqual(['x'])
	})

	test('the server authority set is the kora:server: prefix plus the explicit ids', () => {
		const set = new ServerAuthoritySet(['legacy'])
		expect(set.has('kora:server:any:1')).toBe(true)
		expect(set.has('legacy')).toBe(true)
		expect(set.has('kora:scope-entry')).toBe(false)
		expect(set.has('device')).toBe(false)
	})

	test('authoritative stamps are found at every stamp position of the fold-state format', () => {
		const a = (o: string) => ({ t: 'x', o, c: 1 })
		const json = JSON.stringify({
			v: 1,
			c: 'notes',
			r: 'r1',
			cr: a('cr'),
			w: a('w'),
			d: a('d'),
			u: a('u'),
			f: {
				reg: { k: 'reg', e: [{ s: a('reg'), v: 1 }], val: 1 },
				res: { k: 'res', e: [{ s: a('res'), v: 1, b: null }], val: 1 },
				set: {
					k: 'set',
					ao: false,
					sh: { s: a('set-sh'), arr: true },
					clr: a('set-clr'),
					el: { '"x"': { v: 'x', n: 0, a: a('set-a'), f: { s: a('set-f'), i: 0 }, r: a('set-r') } },
				},
				map: {
					k: 'map',
					sh: { s: a('map-sh'), obj: true },
					clr: a('map-clr'),
					keys: { k1: { s: a('map-key'), del: false, v: 1 } },
				},
				ctr: { k: 'ctr', base: { s: a('ctr-base'), v: 0 }, d: [{ s: a('ctr-d'), n: 1 }], val: 1 },
				max: { k: 'max', best: { s: a('max-best'), v: 1 }, reg: { s: a('max-reg'), v: null } },
				rt: { k: 'rt', reset: { s: a('rt-reset'), v: '' }, u: { AAAA: a('rt-u') } },
				plain: { k: 'reg', e: [{ s: { t: 'y', o: 'not-authoritative' }, v: 1 }], val: 1 },
			},
		})
		expect(authoritativeStampOpIds(json).sort()).toEqual(
			[
				'cr',
				'w',
				'd',
				'u',
				'reg',
				'res',
				'set-sh',
				'set-clr',
				'set-a',
				'set-f',
				'set-r',
				'map-sh',
				'map-clr',
				'map-key',
				'ctr-base',
				'ctr-d',
				'max-best',
				'max-reg',
				'rt-reset',
				'rt-u',
			].sort(),
		)
		expect(authoritativeStampOpIds('{broken')).toEqual([])
	})

	test('values shaped like stamps are never read (RT-76)', () => {
		const forged = { c: 1, t: 'x', o: 'victim-op' }
		const json = JSON.stringify({
			v: 1,
			c: 'notes',
			r: 'r1',
			cr: null,
			w: null,
			d: null,
			u: null,
			f: {
				reg: { k: 'reg', e: [{ s: { t: 'x', o: 'a' }, v: forged, b: forged }], val: forged },
				map: {
					k: 'map',
					sh: { s: { t: 'x', o: 'b' }, obj: true, v: { nested: forged } },
					clr: null,
					keys: { k1: { s: { t: 'x', o: 'c' }, del: false, v: forged } },
				},
				set: {
					k: 'set',
					ao: false,
					sh: null,
					clr: null,
					el: { x: { v: forged, n: 0, a: null, f: null, r: null } },
				},
			},
		})
		expect(authoritativeStampOpIds(json)).toEqual([])
	})
})

describe('keyed server-derived ids (RT-64)', () => {
	test('deterministic per secret, different across secrets, never the unkeyed id', async () => {
		const a = await deriveKeyedServerOpId('00'.repeat(32), 'p', 'server/r', 't')
		expect(await deriveKeyedServerOpId('00'.repeat(32), 'p', 'server/r', 't')).toBe(a)
		expect(await deriveKeyedServerOpId('11'.repeat(32), 'p', 'server/r', 't')).not.toBe(a)
		expect(await deriveSideEffectOpId('p', 'server/r', 't')).not.toBe(a)
		expect(a).toMatch(/^[0-9a-f]{64}$/)
	})

	test('memory stores: each store is its own deployment', async () => {
		const one = new MemoryServerStore()
		const two = new MemoryServerStore()
		expect(await one.deriveServerOperationId('p', 'r', 't')).not.toBe(
			await two.deriveServerOperationId('p', 'r', 't'),
		)
	})
})

describe('SQLite: persisted identity (RT-62)', () => {
	test('a restart keeps the node id, the secret and the authority list', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-identity-'))
		const filename = join(dir, 'server.db')
		try {
			const first = createSqliteServerStore({ filename })
			const id = first.getNodeId()
			const derived = await first.deriveServerOperationId('p', 'r', 't')
			await first.close()
			const second = createSqliteServerStore({ filename })
			expect(second.getNodeId()).toBe(id)
			expect(await second.deriveServerOperationId('p', 'r', 't')).toBe(derived)
			expect(second.getAuthoritativeNodeIds()).toEqual([id])
			await second.close()
			const pinned = createSqliteServerStore({ filename, instanceId: 'blue' })
			expect(pinned.getNodeId()).toBe(id.replace(/:1$/, ':blue'))
			// The other instance authored nothing, so it is not advertised.
			expect(pinned.getAuthoritativeNodeIds()).toEqual([pinned.getNodeId()])
			await pinned.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test('upgrade: an earlier per-process server node id that won a field stays authoritative', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-identity-'))
		const filename = join(dir, 'server.db')
		try {
			// The database as beta.14-dev left it: decisions by a random server node id
			// ('old-server-node'), folded with authority class 1.
			const before = createSqliteServerStore({
				filename,
				authoritativeNodeIds: ['old-server-node'],
			})
			await before.setSchema(schema)
			await before.applyRemoteOperation(
				op('device-a', 1000, { data: { title: 'x', status: 'draft' } }),
			)
			await before.applyRemoteOperation(
				op('old-server-node', 2000, {
					type: 'update',
					data: { status: 'approved' },
					previousData: { status: 'draft' },
				}),
			)
			await before.close()
			const Database = createRequire(import.meta.url)('better-sqlite3')
			const raw = new Database(filename)
			raw
				.prepare('DELETE FROM kora_server_meta WHERE key IN (?, ?)')
				.run(SERVER_LEGACY_SCAN_KEY, SERVER_LEGACY_AUTHORITY_KEY)
			raw.close()

			// The upgraded server is configured without the old id: the scan finds it.
			const after = createSqliteServerStore({ filename })
			await after.setSchema(schema)
			expect(after.getAuthoritativeNodeIds()).toContain('old-server-node')
			// A device's later write does not override the earlier server decision.
			await after.applyRemoteOperation(
				op('device-a', 3000, {
					type: 'update',
					data: { status: 'client' },
					previousData: { status: 'approved' },
				}),
			)
			expect(await after.findRecord('items', 'r1')).toMatchObject({ status: 'approved' })
			await after.close()
			// Recorded for good: a restart keeps advertising it.
			const restarted = createSqliteServerStore({ filename })
			expect(restarted.getAuthoritativeNodeIds()).toContain('old-server-node')
			await restarted.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe.skipIf(!PG_URL)('Postgres: one deployment, distinct instances (RT-62)', () => {
	const clients: Array<ReturnType<typeof postgres>> = []
	afterAll(async () => {
		for (const client of clients) await client.end()
	})

	async function freshSchema(): Promise<() => PostgresServerStore> {
		const name = `kora_identity_${process.pid}_${Date.now()}`
		const admin = postgres(PG_URL as string, { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		await admin.end()
		return () => {
			const client = postgres(PG_URL as string, {
				max: 4,
				onnotice: () => {},
				connection: { search_path: name },
			})
			clients.push(client)
			return new PostgresServerStore(drizzle(client))
		}
	}

	test('instances share the deployment and secret, never a node id; route writes from both win', async () => {
		const open = await freshSchema()
		const s1 = open()
		const s2 = open()
		await s1.setSchema(schema)
		await s2.setSchema(schema)
		const [, , dep1, inst1] = s1.getNodeId().split(':')
		const [, , dep2, inst2] = s2.getNodeId().split(':')
		expect(dep1).toBe(dep2)
		expect(inst1).not.toBe(inst2)
		expect(await s1.deriveServerOperationId('p', 'r', 't')).toBe(
			await s2.deriveServerOperationId('p', 'r', 't'),
		)
		// A restarted instance gets a fresh instance id (no configured instanceId).
		await s1.close()
		const s3 = open()
		await s3.setSchema(schema)
		expect(s3.getNodeId()).not.toBe(s1.getNodeId())
		expect(s3.getNodeId().split(':')[2]).toBe(dep1)
		await s2.close()
		await s3.close()
	})
})
