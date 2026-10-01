// LMS-8: scope predicates on `id` (e.g. { id: { $in: [...] } }).
// Tests assert CORRECT behaviour. "[fails today]" = reproduces a live bug.
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { ClientSession, MemoryServerStore, operationMatchesScopes } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncEngine } from '@korajs/sync'
import { operationMatchesScope } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ScopedNet, settle } from './lms-scope-harness'

const schema = defineSchema({
	version: 1,
	collections: {
		courses: { fields: { title: t.string(), status: t.string().optional() } },
	},
})

type Scopes = Record<string, Record<string, unknown>>

// ---- The LMS #8 patch, transcribed verbatim -------------------------------
function lmsBuildSnapshot(o: Operation, fullRecord?: Record<string, unknown> | null) {
	const previous = (o.previousData ?? null) as Record<string, unknown> | null
	const next = (o.data ?? null) as Record<string, unknown> | null
	if (!previous && !next && !fullRecord) return null
	const merged: Record<string, unknown> = {
		...(fullRecord ?? {}),
		...(previous ?? {}),
		...(next ?? {}),
	}
	if (!('id' in merged) && o.recordId) merged.id = o.recordId
	return merged
}
// ---- A correct snapshot: stored row authoritative, id forced from recordId -
function fixedSnapshot(o: Operation, stored?: Record<string, unknown> | null) {
	if (o.data && 'id' in o.data && o.data.id !== o.recordId) return null // malformed
	return { ...(stored ?? {}), ...((o.data ?? {}) as Record<string, unknown>), id: o.recordId }
}
function pred(actual: unknown, expected: unknown) {
	if (expected && typeof expected === 'object' && '$in' in (expected as object))
		return ((expected as { $in: unknown[] }).$in ?? []).some((v) => Object.is(v, actual))
	return Object.is(actual, expected)
}
function matchWith(
	snap: (o: Operation, f?: Record<string, unknown> | null) => Record<string, unknown> | null,
	o: Operation,
	scopes: Scopes | undefined,
	full?: Record<string, unknown> | null,
) {
	if (!scopes) return true
	const cs = scopes[o.collection]
	if (!cs) return false
	if (Object.keys(cs).length === 0) return true
	const s = snap(o, full)
	if (!s) return false
	return Object.entries(cs).every(([f, e]) => pred(s[f], e))
}

let net: ScopedNet | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

async function seedTwoCourses() {
	net = new ScopedNet(schema)
	net.auth.set('admin', { userId: 'admin' })
	const admin = await net.device('admin', 'admin')
	await admin.sync()
	const a = await admin.collection('courses').insert({ title: 'A' })
	const b = await admin.collection('courses').insert({ title: 'B' })
	await admin.sync()
	expect(net.serverStore.getAllOperations()).toHaveLength(2)
	return { net, a, b }
}

describe('LMS-8 id-scoped predicates, end to end (real server + SyncEngine + SQLite)', () => {
	test('[control, passes] collection-wide scope delivers both records', async () => {
		const { net } = await seedTwoCourses()
		net.auth.set('s', { userId: 's', scopes: { courses: {} } })
		const s = await net.device('s', 's')
		await s.sync()
		expect((await s.rows('courses')).map((r) => r.title).sort()).toEqual(['A', 'B'])
	})

	test('[fails today] inbound, non-directional: record whose id is in scope reaches the client', async () => {
		const { net, a } = await seedTwoCourses()
		net.auth.set('s', { userId: 's', scopes: { courses: { id: { $in: [a.id] } } } })
		const s = await net.device('s', 's')
		await s.sync()
		// Server delivers A (downlink check backfills `id` from the stored row); the
		// client inbound filter re-checks the bare insert, snapshot has no `id`, there is
		// no local row to backfill from, so the insert is silently dropped.
		expect((await s.rows('courses')).map((r) => r.title)).toEqual(['A'])
	})

	test('[passes with LMS #8 client patch] same scenario with the patched client snapshot', async () => {
		const { net, a } = await seedTwoCourses()
		net.auth.set('s', { userId: 's', scopes: { courses: { id: { $in: [a.id] } } } })
		const s = await net.device('s', 's', (engine: SyncEngine) => {
			const e = engine as unknown as {
				matchesScopeAndSubsets: (o: Operation, f?: Record<string, unknown> | null) => boolean
				activeUplinkScope: Scopes | undefined
			}
			e.matchesScopeAndSubsets = (o, f) => matchWith(lmsBuildSnapshot, o, e.activeUplinkScope, f)
		})
		await s.sync()
		expect((await s.rows('courses')).map((r) => r.title)).toEqual(['A'])
	})

	test('[passes with planned SYNC-2 split] inbound applies what the server delivered', async () => {
		const { net, a } = await seedTwoCourses()
		net.auth.set('s', { userId: 's', scopes: { courses: { id: { $in: [a.id] } } } })
		const s = await net.device('s', 's', (engine: SyncEngine) => {
			const e = engine as unknown as {
				filterAllowedForSync: (ops: Operation[]) => Promise<Operation[]>
			}
			const orig = e.filterAllowedForSync.bind(engine)
			e.filterAllowedForSync = async (ops) =>
				new Error().stack?.includes('handleOperationBatch') ? ops : orig(ops)
		})
		await s.sync()
		expect((await s.rows('courses')).map((r) => r.title)).toEqual(['A'])
	})

	test('[fails today] inbound, directional (downlink all, uplink id-scoped): client receives everything downlink allows', async () => {
		const { net, a } = await seedTwoCourses()
		net.auth.set('e', {
			userId: 'e',
			downlinkScopes: { courses: {} },
			uplinkScopes: { courses: { id: { $in: [a.id] } } },
		})
		const e = await net.device('e', 'e')
		await e.sync()
		// Two compounding causes: inbound filter uses the UPLINK scope (SYNC-2), and the
		// bare insert snapshot lacks `id`. B is out of uplink scope: dropped even with #8.
		expect((await e.rows('courses')).map((r) => r.title).sort()).toEqual(['A', 'B'])
	})
})

// ---------------------------------------------------------------------------
// Server upload path (ClientSession): id-scoped uplink authorization.
// ---------------------------------------------------------------------------

function op(overrides: Partial<Operation>): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'attacker-node',
		type: 'insert',
		collection: 'courses',
		recordId: 'rec',
		data: { title: 't' },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'attacker-node' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

const ID_SCOPE: Scopes = { courses: { id: { $in: ['allowed'] } } }

async function session(
	patch?: 'lms' | 'fixed',
	opts: { withSchema?: boolean } = { withSchema: true },
) {
	const store = new MemoryServerStore('server-1')
	if (opts.withSchema) await store.setSchema(schema)
	let seq = 0
	for (const rid of ['allowed', 'victim']) {
		await store.applyRemoteOperation(
			op({
				id: `seed-${rid}`,
				nodeId: 'seed',
				recordId: rid,
				data: { title: `orig-${rid}` },
				sequenceNumber: ++seq,
			}),
		)
	}
	const { client, server } = createServerTransportPair()
	const messages: Array<{ type: string; operationId?: string; code?: string }> = []
	client.onMessage((m) => messages.push(m as never))
	const s = new ClientSession({
		sessionId: 's',
		transport: server,
		store,
		auth: {
			authenticate: async () => ({
				userId: 'attacker',
				uplinkScopes: ID_SCOPE,
				downlinkScopes: ID_SCOPE,
			}),
		},
	})
	if (patch) {
		const snap = patch === 'lms' ? lmsBuildSnapshot : fixedSnapshot
		const lookup = async (o: Operation) =>
			(
				await store.queryCollection(o.collection, {
					where: { id: o.recordId },
					includeDeleted: true,
					limit: 1,
				})
			)[0]
		;(
			s as unknown as { operationAllowedFromClient: (o: Operation) => Promise<boolean> }
		).operationAllowedFromClient = async (o) => {
			if (patch === 'fixed') return matchWith(snap, o, ID_SCOPE, await lookup(o))
			// LMS: same flow as shipped operationAllowedFromClient (lookup only if a scope
			// field is missing from the bare-op snapshot), with the patched snapshot.
			const missing = Object.keys(ID_SCOPE.courses ?? {}).some((f) => !(f in (snap(o) ?? {})))
			return matchWith(snap, o, ID_SCOPE, missing ? await lookup(o) : undefined)
		}
	}
	s.start()
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: 'attacker-node',
		versionVector: {},
		schemaVersion: 1,
		authToken: 'x',
		supportedWireFormats: ['json'],
	} as never)
	await vi.waitFor(() => expect(s.getState()).toBe('streaming'))
	const send = async (forged: Operation) => {
		client.send({
			type: 'operation-batch',
			messageId: `b-${forged.id}`,
			operations: [forged],
			isFinal: true,
			batchIndex: 0,
		} as never)
		await vi.waitFor(() => expect(messages.some((m) => m.type === 'acknowledgment')).toBe(true))
		await settle(2)
		const rows = await store.queryCollection('courses', {
			where: { id: forged.recordId },
			includeDeleted: true,
		})
		const rejected = messages.filter(
			(m) => m.type === 'operation-rejected' && m.operationId === forged.id,
		)
		return { row: rows[0] as Record<string, unknown> | undefined, rejected }
	}
	return { store, s, send }
}

const forgedViaData = () =>
	op({
		id: 'forged-data',
		type: 'update',
		recordId: 'victim',
		data: { id: 'allowed', title: 'PWNED' },
		previousData: { title: 'orig-victim' },
	})
const forgedViaPrevious = () =>
	op({
		id: 'forged-prev',
		type: 'update',
		recordId: 'victim',
		data: { title: 'PWNED' },
		previousData: { id: 'allowed', title: 'orig-victim' },
	})
const forgedDelete = () =>
	op({
		id: 'forged-del',
		type: 'delete',
		recordId: 'victim',
		data: null,
		previousData: { id: 'allowed' },
	})

describe('LMS-8 server upload with id-scoped uplink', () => {
	test('[passes] legit update to an in-scope existing record is accepted', async () => {
		const { send } = await session()
		const legit = op({
			id: 'legit',
			type: 'update',
			recordId: 'allowed',
			data: { status: 'published' },
			previousData: { status: null },
		})
		const r = await send(legit)
		expect(r.rejected).toEqual([])
		expect(r.row?.status).toBe('published')
	})

	test('[passes] forged data.id is rejected today — but only by schema shape validation (SCHEMA_VALIDATION_ERROR), not by scope', async () => {
		const { send } = await session()
		const r = await send(forgedViaData())
		expect(r.rejected.map((m) => m.code)).toEqual(['SCHEMA_VALIDATION_ERROR'])
		expect(r.row?.title).toBe('orig-victim')
	})

	test('[fails today] forged previousData.id (allowed by shape validation) must not authorize an update to an out-of-scope record', async () => {
		const { send } = await session()
		const r = await send(forgedViaPrevious())
		expect(r.row?.title).toBe('orig-victim')
		expect(r.rejected).toHaveLength(1)
	})

	test('[fails today] forged previousData.id must not authorize a delete of an out-of-scope record', async () => {
		const { send, store } = await session()
		const r = await send(forgedDelete())
		const live = await store.queryCollection('courses', { where: { id: 'victim' } })
		expect(live).toHaveLength(1) // victim must still be live
		expect(r.rejected).toHaveLength(1)
	})

	test('[fails with LMS patch] LMS #8 patch does not close the previousData.id bypass', async () => {
		const { send } = await session('lms')
		const r = await send(forgedViaPrevious())
		expect(r.row?.title).toBe('orig-victim')
		expect(r.rejected).toHaveLength(1)
	})

	test('[passes with correct fix] id forced from recordId + stored row authoritative rejects all forgeries', async () => {
		for (const [mk, withSchema] of [
			[forgedViaPrevious, true],
			[forgedDelete, true],
			[forgedViaData, true],
		] as const) {
			const { send } = await session('fixed', { withSchema })
			const r = await send(mk())
			expect(r.rejected).toHaveLength(1)
			expect(r.row?.title).toBe('orig-victim')
		}
	})

	test('[fails today] insert whose recordId is in an id-scoped uplink is accepted (no stored row to backfill id)', async () => {
		const scoped = await session()
		const ins = op({ id: 'ins-allowed', recordId: 'allowed-new', data: { title: 'new' } })
		// ID_SCOPE only allows 'allowed'; use a session whose scope allows 'allowed-new'.
		void scoped
		const store = new MemoryServerStore('server-2')
		await store.setSchema(schema)
		const scopes = { courses: { id: { $in: ['allowed-new'] } } }
		const { client, server } = createServerTransportPair()
		const msgs: Array<{ type: string; operationId?: string; code?: string }> = []
		client.onMessage((m) => msgs.push(m as never))
		const s = new ClientSession({
			sessionId: 's2',
			transport: server,
			store,
			auth: {
				authenticate: async () => ({ userId: 'u', uplinkScopes: scopes, downlinkScopes: scopes }),
			},
		})
		s.start()
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'attacker-node',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'x',
			supportedWireFormats: ['json'],
		} as never)
		await vi.waitFor(() => expect(s.getState()).toBe('streaming'))
		client.send({
			type: 'operation-batch',
			messageId: 'b',
			operations: [ins],
			isFinal: true,
			batchIndex: 0,
		} as never)
		await vi.waitFor(() => expect(msgs.some((m) => m.type === 'acknowledgment')).toBe(true))
		expect(msgs.filter((m) => m.type === 'operation-rejected')).toEqual([])
	})
})

describe('LMS-8 pure matcher facts', () => {
	test('shipped matchers let op fields override the stored id (SEC-2 class)', () => {
		const stored = { id: 'victim', title: 'orig' }
		expect(operationMatchesScopes(forgedViaPrevious(), ID_SCOPE, stored)).toBe(true)
		expect(operationMatchesScope(forgedViaPrevious(), ID_SCOPE, stored)).toBe(true)
		expect(matchWith(lmsBuildSnapshot, forgedViaPrevious(), ID_SCOPE, stored)).toBe(true)
		expect(matchWith(fixedSnapshot, forgedViaPrevious(), ID_SCOPE, stored)).toBe(false)
	})
})
