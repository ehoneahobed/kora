/**
 * Two people on one shared browser, end to end with real stores and the real server.
 *
 * The app opens one database per user (`store.namespaceByAuthUser`) and the auth binding
 * pins each database's node to the auth device id. beta.12 gave every account on a
 * browser the same device id, so both users' databases authored under ONE node, each
 * numbering its own sequence from 1; the server's version-vector entry for that node mixes
 * both. Now each account gets a device id (node) of its own: the device's registered
 * owner keeps the old node (and the server hands it over to them), the other account's
 * database retires it, asks the server by id which of its writes it holds, and re-authors
 * the rest under its own node. Nothing is lost, duplicated or uploaded as the other user.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { KoraEvent, Operation } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore, TokenAuthProvider } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import { serializeVersionVectorToMeta } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { MAX_PROBE_OPERATION_IDS } from '@korajs/sync'
import { StoreQueueStorage } from 'korajs/testing'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../src/test-device'
import type { TestServer } from '../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { body: t.string(), owner: t.string(), count: t.number().default(0) } },
	},
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

type User = 'ama' | 'kofi'

/** The shared browser's first device id: the auth server registered it to Ama, the first account. */
const BROWSER_DEVICE = 'browser-device'
/** The device id Kofi's account gets of its own on that browser (the auth fix). */
const KOFI_DEVICE = 'kofi-own-device'

async function sharedBrowser(options: { probe?: boolean; sharedNotes?: boolean } = {}) {
	const store = new MemoryServerStore()
	await store.setSchema(schema)
	/** Which user's session submitted each body (the uploads the server judged). */
	const submittedBy = new Map<string, string[]>()
	const server = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		// The auth provider verified the token's device id, as the built-in one does from
		// the `dev` claim (a device registered to that user).
		auth: new TokenAuthProvider({
			validate: async (token) => {
				const [userId, deviceId] = token.split('@')
				if (!userId || !deviceId) return null
				// `sharedNotes`: every user reads and writes every note (a class's shared board).
				if (options.sharedNotes) return { userId, metadata: { deviceId } }
				return { userId, metadata: { deviceId }, scopes: { notes: { owner: userId } } }
			},
		}),
		validateOperation: async (op, ctx) => {
			const body = String(op.data?.body ?? op.id)
			submittedBy.set(body, [...(submittedBy.get(body) ?? []), String(ctx.auth?.userId)])
			return { action: 'accept' }
		},
	})
	cleanup.push(() => server.stop())
	const tmp = mkdtempSync(join(tmpdir(), 'shared-browser-'))
	cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
	const probeSwitch = { on: options.probe ?? true }
	const viaToken = (token: string): TestServer =>
		({
			handleConnection(transport: ServerTransport): string {
				return server.handleConnection({
					send: (m: SyncMessage) => transport.send(m),
					onMessage: (h) =>
						transport.onMessage((m: SyncMessage) => {
							if (m.type !== 'handshake') return h(m)
							const { probeOperationIds: _asked, ...rest } = m
							// A server from before the probe never sees (or answers) the question.
							return h({ ...(probeSwitch.on ? m : rest), authToken: token } as SyncMessage)
						}),
					onClose: (h) => transport.onClose(h),
					onError: (h) => transport.onError(h),
					isConnected: () => transport.isConnected(),
					close: (c, r) => transport.close(c, r),
				})
			},
		}) as unknown as TestServer
	const opened: TestDevice[] = []
	/** One user's database on the browser (`kora-db__user_<id>`), pinned to a device id. */
	const database = (user: User, deviceId: string): TestDevice => {
		const device = new TestDevice({
			name: `${user}-${deviceId}`,
			dbFile: `kora-db__user_${user}.db`,
			schema,
			server: viaToken(`${user}@${deviceId}`),
			tmpDir: tmp,
			nodeId: deviceId,
			databaseOwner: user,
			principal: () => user,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		opened.push(device)
		cleanup.push(() => device.close().catch(() => undefined))
		return device
	}
	const cycle = async (device: TestDevice, n = 3): Promise<void> => {
		for (let i = 0; i < n; i++) {
			await device.disconnect()
			await device.sync()
		}
	}
	/**
	 * Reconnect until the device has nothing pending or held. A repair ends its session on
	 * purpose (to continue with the next batch of a retired node, or after an adoption), and
	 * one session's work can outlast `sync()`'s settling on a loaded machine: the number of
	 * sessions a device needs is not fixed, so the test waits for the outcome, never a count.
	 */
	const settle = async (device: TestDevice, maxSessions = 40): Promise<void> => {
		const trail: string[] = []
		const record = (event: KoraEvent): void => {
			if (
				event.type === 'sync:local-node' ||
				event.type === 'store:persistence-error' ||
				event.type === 'sync:operation-rejected' ||
				event.type === 'sync:apply-blocked'
			) {
				trail.push(JSON.stringify(event).slice(0, 300))
			}
		}
		const offs = [
			'sync:local-node',
			'store:persistence-error',
			'sync:operation-rejected',
			'sync:apply-blocked',
		].map((type) => device.emitter.on(type as KoraEvent['type'], record as never))
		try {
			for (let i = 0; i < maxSessions; i++) {
				await device.disconnect()
				await device.sync()
				const status = device.getSyncEngine()?.getStatus()
				if (status && status.pendingOperations === 0 && status.heldOperations === 0) return
				trail.push(
					`session ${i}: ${status?.status} pending ${status?.pendingOperations} held ${status?.heldOperations} vector ${JSON.stringify([...device.store.getVersionVector()])}`,
				)
			}
			// Not settled: say why (CI only shows the assertion).
			const nodes = await device.store.listLocalNodes()
			expect(
				{ status: device.getSyncEngine()?.getStatus(), nodes, trail: trail.slice(-60) },
				'device did not settle',
			).toMatchObject({ status: { pendingOperations: 0, heldOperations: 0 } })
		} finally {
			for (const fn of offs) fn()
		}
	}
	return { store, server, submittedBy, tmp, database, cycle, settle, probe: probeSwitch }
}

type Ctx = Awaited<ReturnType<typeof sharedBrowser>>

/**
 * A database a beta.12 browser left: written under the browser's one device id, some of
 * it uploaded to a beta.12 server (stored under the node with no owner, beside the other
 * user's operations under the same numbers), the rest queued offline. Rewritten to look
 * exactly like beta.12 left it: no node registry, no acknowledged prefix, the server's
 * (shared) vector entry persisted as acknowledged, the unsent writes in the queue.
 */
async function beta12Database(
	ctx: Ctx,
	user: User,
	bodies: { uploaded: string[]; queued: string[]; dropped?: string[] },
	sharedVectorEntry: number,
): Promise<Operation[]> {
	const device = ctx.database(user, BROWSER_DEVICE)
	await device.open()
	const notes = device.collection('notes')
	// `dropped`: written offline, then dropped from the queue by beta.12 (it counted them as
	// synced: the shared node's vector entry, raised by the other database, covered them).
	for (const body of [...bodies.uploaded, ...bodies.queued, ...(bodies.dropped ?? [])])
		await notes.insert({ body, owner: user })
	const ops = await device.store.getOperationRange(BROWSER_DEVICE, 1, 100_000)
	await device.close()
	const uploaded = ops.filter((op) => bodies.uploaded.includes(String(op.data?.body)))
	for (const op of uploaded) {
		// beta.12 stored a second operation under a held (node, sequence) (RT-37).
		const result = await ctx.store.applyRemoteOperation(op, { legacySequenceWriter: true })
		expect(result).not.toBe('rejected')
	}
	const file = join(ctx.tmp, `kora-db__user_${user}.db`)
	const raw = new BetterSqlite3Adapter(file)
	await raw.open(schema)
	await raw.execute('DELETE FROM _kora_local_nodes')
	await raw.execute("DELETE FROM _kora_meta WHERE key LIKE 'own_acked_through%'")
	await raw.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
		'last_acked_server_vector',
		serializeVersionVectorToMeta(new Map([[BROWSER_DEVICE, sharedVectorEntry]])),
	])
	const queue = new StoreQueueStorage(raw)
	for (const op of ops.filter((o) => bodies.queued.includes(String(o.data?.body)))) {
		await queue.enqueue(op)
	}
	await raw.close()
	return ops
}

async function serverBodies(ctx: Ctx): Promise<string[]> {
	return (await ctx.store.queryCollection('notes')).map((row) => String(row.body)).sort()
}

/** Every stored operation of a body, with the node it was stored under. */
async function storedOps(ctx: Ctx): Promise<Array<{ body: string; node: string; id: string }>> {
	const out: Array<{ body: string; node: string; id: string }> = []
	const vector = await ctx.store.getVersionVector()
	for (const [node, max] of vector) {
		for (const op of await ctx.store.getOperationRange(node, 1, max)) {
			if (op.collection === 'notes') out.push({ body: String(op.data?.body), node, id: op.id })
		}
	}
	return out
}

/** The users whose sessions submitted a body (a resend of the same operation counts once). */
function submitters(ctx: Ctx, body: string): string[] {
	return [...new Set(ctx.submittedBy.get(body) ?? [])]
}

/** Every body is stored as exactly one operation (one id) on the server. */
async function expectEachStoredOnce(ctx: Ctx): Promise<void> {
	const stored = await storedOps(ctx)
	expect(new Set(stored.map((op) => op.id)).size).toBe(stored.length)
	const perBody = new Map<string, number>()
	for (const op of stored) perBody.set(op.body, (perBody.get(op.body) ?? 0) + 1)
	for (const [body, count] of perBody) expect([body, count]).toEqual([body, 1])
}

describe('one browser, two accounts, a node each', () => {
	for (const order of [
		['ama', 'kofi'],
		['kofi', 'ama'],
	] as const) {
		test(`offline writes by both upload as their authors (${order.join(' then ')} online first)`, async () => {
			const ctx = await sharedBrowser()
			const devices = { ama: BROWSER_DEVICE, kofi: KOFI_DEVICE }
			for (const user of ['ama', 'kofi'] as const) {
				const db = ctx.database(user, devices[user])
				await db.open()
				await db.collection('notes').insert({ body: `${user} offline 1`, owner: user })
				await db.collection('notes').insert({ body: `${user} offline 2`, owner: user })
				await db.close()
			}
			for (const user of order) {
				const db = ctx.database(user, devices[user])
				await db.open()
				await ctx.settle(db)
			}
			expect(await serverBodies(ctx)).toEqual([
				'ama offline 1',
				'ama offline 2',
				'kofi offline 1',
				'kofi offline 2',
			])
			// Uploaded on its author's session only (a batch resent after a reconnect is the same
			// operation: the server stores it once, see below).
			for (const [body, users] of ctx.submittedBy) {
				expect([body, [...new Set(users)]]).toEqual([body, [body.split(' ')[0]]])
			}
			await expectEachStoredOnce(ctx)
			expect(await ctx.store.getNodeClaimOwner(BROWSER_DEVICE)).toBe('ama')
			expect(await ctx.store.getNodeClaimOwner(KOFI_DEVICE)).toBe('kofi')
		}, 60_000)
	}
})

describe('stores a beta.12 shared browser left under one node', () => {
	for (const first of ['kofi', 'ama'] as const) {
		test(`are repaired: every write uploads once, as its author (${first} signs in first)`, async () => {
			const ctx = await sharedBrowser()
			// Ama wrote first: one write reached the beta.12 server, two are queued.
			const amaOps = await beta12Database(
				ctx,
				'ama',
				{ uploaded: ['ama 1'], queued: ['ama 2', 'ama 3'] },
				1,
			)
			// Kofi then used the same device id: his sequence numbers repeat Ama's. One write
			// reached the server (beside Ama's under the same number), three are queued. The
			// shared vector entry he persisted (3, raised by Ama's writes) "covers" his queue.
			const kofiOps = await beta12Database(
				ctx,
				'kofi',
				{ uploaded: ['kofi 1'], queued: ['kofi 2', 'kofi 3', 'kofi 4'] },
				3,
			)
			expect(amaOps[0]?.sequenceNumber).toBe(kofiOps[0]?.sequenceNumber)

			const rewritten: Record<string, string> = {}
			const signIn = async (user: User): Promise<TestDevice> => {
				// After the upgrade Ama keeps the browser's device id; Kofi has one of his own.
				const db = ctx.database(user, user === 'ama' ? BROWSER_DEVICE : KOFI_DEVICE)
				db.emitter.on('sync:operations-rewritten', (event: KoraEvent) => {
					if (event.type === 'sync:operations-rewritten' && event.reason === 'node-rotation') {
						Object.assign(rewritten, event.idMapping)
					}
				})
				await db.open()
				await ctx.settle(db)
				return db
			}
			const second = first === 'ama' ? 'kofi' : 'ama'
			const dbs = { [first]: await signIn(first), [second]: await signIn(second) } as Record<
				User,
				TestDevice
			>

			// Every write is on the server once.
			expect(await serverBodies(ctx)).toEqual([
				'ama 1',
				'ama 2',
				'ama 3',
				'kofi 1',
				'kofi 2',
				'kofi 3',
				'kofi 4',
			])
			const stored = await storedOps(ctx)
			const perBody = new Map<string, number>()
			for (const op of stored) perBody.set(op.body, (perBody.get(op.body) ?? 0) + 1)
			for (const [body, count] of perBody) expect([body, count]).toEqual([body, 1])
			// Uploaded on its author's session, never on the other user's.
			for (const [body, users] of ctx.submittedBy) {
				expect([body, [...new Set(users)]]).toEqual([body, [body.split(' ')[0]]])
			}
			expect(ctx.submittedBy.has('kofi 1')).toBe(false) // beta.12 stored it: never re-sent
			// Kofi's queued writes went up under his own node, re-authored; what beta.12
			// stored under the shared node stayed there.
			const nodeOf = new Map(stored.map((op) => [op.body, op.node]))
			expect(nodeOf.get('kofi 1')).toBe(BROWSER_DEVICE)
			for (const body of ['kofi 2', 'kofi 3', 'kofi 4']) expect(nodeOf.get(body)).toBe(KOFI_DEVICE)
			for (const body of ['ama 1', 'ama 2', 'ama 3']) expect(nodeOf.get(body)).toBe(BROWSER_DEVICE)
			expect(Object.keys(rewritten).sort()).toEqual(
				kofiOps
					.filter((op) => ['kofi 2', 'kofi 3', 'kofi 4'].includes(String(op.data?.body)))
					.map((op) => op.id)
					.sort(),
			)
			// The device's registered owner was handed the old node; Kofi owns his own.
			expect(await ctx.store.getNodeClaimOwner(BROWSER_DEVICE)).toBe('ama')
			expect(await ctx.store.getNodeClaimOwner(KOFI_DEVICE)).toBe('kofi')
			// Each database reads its own writes, and nothing of the other user's.
			for (const user of ['ama', 'kofi'] as const) {
				const rows = await dbs[user].getState('notes')
				expect(rows.every((row) => row.owner === user)).toBe(true)
			}
			expect((await dbs.kofi.getState('notes')).map((r) => r.body).sort()).toEqual([
				'kofi 1',
				'kofi 2',
				'kofi 3',
				'kofi 4',
			])
			// The retired node has nothing left to do on Kofi's database.
			const kofiNodes = await dbs.kofi.store.listLocalNodes()
			const old = kofiNodes.find((node) => node.nodeId === BROWSER_DEVICE)
			if (old) expect(old).toMatchObject({ retired: true, principal: 'kofi' })
		}, 90_000)
	}

	test('writes made under the new node before the repair upload too, and the server is asked only once', async () => {
		const ctx = await sharedBrowser()
		await beta12Database(ctx, 'ama', { uploaded: ['ama 1'], queued: [] }, 1)
		await beta12Database(ctx, 'kofi', { uploaded: [], queued: ['kofi queued on beta.12'] }, 1)
		const kofi = ctx.database('kofi', KOFI_DEVICE)
		await kofi.open()
		// Offline after the sign-in: written under his own node, before any handshake.
		await kofi.collection('notes').insert({ body: 'kofi offline on the canary', owner: 'kofi' })
		const probes: string[][] = []
		kofi.emitter.on('sync:local-node', (event: KoraEvent) => {
			if (event.type === 'sync:local-node' && event.action === 'retired-repaired') {
				probes.push([String(event.operationCount), String(event.storedCount)])
			}
		})
		await ctx.settle(kofi)
		expect(probes).toEqual([['1', '0']])
		expect(await serverBodies(ctx)).toEqual([
			'ama 1',
			'kofi offline on the canary',
			'kofi queued on beta.12',
		])
		expect(submitters(ctx, 'kofi queued on beta.12')).toEqual(['kofi'])
		await expectEachStoredOnce(ctx)
	}, 60_000)

	test('a server that cannot answer the question gets nothing re-authored; the writes wait, counted', async () => {
		const ctx = await sharedBrowser({ probe: false })
		await beta12Database(ctx, 'ama', { uploaded: ['ama 1'], queued: [] }, 1)
		await beta12Database(ctx, 'kofi', { uploaded: ['kofi 1'], queued: ['kofi 2'] }, 2)
		const kofi = ctx.database('kofi', KOFI_DEVICE)
		const rewrites: unknown[] = []
		kofi.emitter.on('sync:operations-rewritten', (event: KoraEvent) => rewrites.push(event))
		await kofi.open()
		await ctx.cycle(kofi, 2)
		const engine = kofi.getSyncEngine()
		if (!engine) throw new Error('no engine')
		// Both of the retired node's writes stay pending: neither is known to be stored.
		expect(engine.getStatus().pendingOperations).toBe(2)
		expect(rewrites).toEqual([])
		expect(ctx.submittedBy.has('kofi 2')).toBe(false)

		// The server is upgraded: the next handshake repairs.
		ctx.probe.on = true
		await ctx.settle(kofi)
		expect(submitters(ctx, 'kofi 2')).toEqual(['kofi'])
		expect(ctx.submittedBy.has('kofi 1')).toBe(false)
		const stored = await storedOps(ctx)
		expect(stored.filter((op) => op.body === 'kofi 1')).toHaveLength(1)
		expect(stored.filter((op) => op.body === 'kofi 2')).toHaveLength(1)
	}, 60_000)

	test('a write the server refused for good is never re-authored', async () => {
		const ctx = await sharedBrowser()
		await beta12Database(ctx, 'ama', { uploaded: ['ama 1'], queued: [] }, 1)
		const kofiOps = await beta12Database(
			ctx,
			'kofi',
			{ uploaded: [], queued: ['kofi refused', 'kofi fine'] },
			1,
		)
		const refused = kofiOps.find((op) => op.data?.body === 'kofi refused')
		if (!refused) throw new Error('no op')
		// beta.12 recorded the server's terminal refusal in its rejected list.
		const raw = new BetterSqlite3Adapter(join(ctx.tmp, 'kora-db__user_kofi.db'))
		await raw.open(schema)
		await raw.execute(
			'CREATE TABLE IF NOT EXISTS _kora_sync_rejected (operation_id TEXT PRIMARY KEY, collection TEXT, record_id TEXT, code TEXT, message TEXT, retriable INTEGER, rejected_at INTEGER)',
		)
		await raw.execute(
			"INSERT INTO _kora_sync_rejected VALUES (?, 'notes', ?, 'VALIDATION_FAILED', 'no', 0, 1)",
			[refused.id, refused.recordId],
		)
		await raw.execute("DELETE FROM _kora_meta WHERE key = 'terminal_rejections_seeded_v1'")
		await raw.close()

		const kofi = ctx.database('kofi', KOFI_DEVICE)
		await kofi.open()
		await ctx.settle(kofi)
		expect(ctx.submittedBy.has('kofi refused')).toBe(false)
		expect(submitters(ctx, 'kofi fine')).toEqual(['kofi'])
		await expectEachStoredOnce(ctx)
	}, 60_000)

	test(`more than ${MAX_PROBE_OPERATION_IDS} writes are asked about over several handshakes`, async () => {
		const ctx = await sharedBrowser()
		await beta12Database(ctx, 'ama', { uploaded: ['ama 1'], queued: [] }, 1)
		const queued = Array.from({ length: MAX_PROBE_OPERATION_IDS + 20 }, (_, i) => `kofi ${i + 1}`)
		await beta12Database(ctx, 'kofi', { uploaded: [], queued }, 1)
		const kofi = ctx.database('kofi', KOFI_DEVICE)
		await kofi.open()
		await ctx.settle(kofi)
		const bodies = await serverBodies(ctx)
		expect(bodies).toHaveLength(queued.length + 1)
		for (const body of queued) expect(submitters(ctx, body)).toEqual(['kofi'])
		// Each write is stored once, under one id: a batch resent after a reconnect is
		// deduplicated by id, never stored twice.
		await expectEachStoredOnce(ctx)
		// The retired node has nothing left: every one of its writes was asked about.
		const old = (await kofi.store.listLocalNodes()).find((node) => node.nodeId === BROWSER_DEVICE)
		if (old) expect(old).toMatchObject({ retired: true, principal: 'kofi' })
	}, 120_000)
	test('a repair that stops after re-authoring (before the engine updates its queue) still settles', async () => {
		const ctx = await sharedBrowser()
		await beta12Database(ctx, 'ama', { uploaded: ['ama 1'], queued: [] }, 1)
		const kofiOps = await beta12Database(
			ctx,
			'kofi',
			{ uploaded: [], queued: ['kofi 1', 'kofi 2'] },
			1,
		)
		const kofi = ctx.database('kofi', KOFI_DEVICE)
		await kofi.open()
		// The server answered "none stored" and the store re-authored both; the process ended
		// before the engine replaced the queue entries.
		await kofi.store.reauthorIntoOwnNode(
			BROWSER_DEVICE,
			kofiOps.map((op) => op.id),
		)
		await kofi.close()

		const again = ctx.database('kofi', KOFI_DEVICE)
		await again.open()
		await ctx.settle(again)
		expect(submitters(ctx, 'kofi 1')).toEqual(['kofi'])
		expect(submitters(ctx, 'kofi 2')).toEqual(['kofi'])
		await expectEachStoredOnce(ctx)
	}, 60_000)

	test('a write it received under the shared node is never uploaded as its own', async () => {
		for (const first of ['kofi', 'ama'] as const) {
			// Notes both users may write: only authorship keeps Kofi from re-sending Ama's.
			const ctx = await sharedBrowser({ sharedNotes: true })
			const amaOps = await beta12Database(
				ctx,
				'ama',
				{ uploaded: ['ama 1'], queued: ['ama 2', 'ama 3', 'ama 4'] },
				1,
			)
			await beta12Database(ctx, 'kofi', { uploaded: [], queued: ['kofi 1'] }, 1)
			// Ama's fourth write reached Kofi's database under the shared node after the upgrade
			// (recorded as received), and the server does not hold it (restored from a backup).
			const shared = amaOps.find((op) => op.data?.body === 'ama 4')
			if (!shared) throw new Error('no op')
			const legacy = ctx.database('kofi', BROWSER_DEVICE)
			await legacy.open()
			await legacy.store.applyRemoteOperation(shared)
			await legacy.close()
			const raw = new BetterSqlite3Adapter(join(ctx.tmp, 'kora-db__user_kofi.db'))
			await raw.open(schema)
			await raw.execute('DELETE FROM _kora_local_nodes')
			await raw.close()

			for (const user of first === 'kofi'
				? (['kofi', 'ama'] as const)
				: (['ama', 'kofi'] as const)) {
				const db = ctx.database(user, user === 'ama' ? BROWSER_DEVICE : KOFI_DEVICE)
				await db.open()
				await ctx.settle(db)
			}
			expect(submitters(ctx, 'ama 4')).toEqual(['ama'])
			expect(submitters(ctx, 'kofi 1')).toEqual(['kofi'])
			await expectEachStoredOnce(ctx)
			const nodeOf = new Map((await storedOps(ctx)).map((op) => [op.body, op.node]))
			expect(nodeOf.get('ama 4')).toBe(BROWSER_DEVICE)
		}
	}, 120_000)
	for (const first of ['kofi', 'ama'] as const) {
		test(`a write beta.12 dropped from the queue still uploads, as its author (${first} signs in first)`, async () => {
			const ctx = await sharedBrowser()
			await beta12Database(ctx, 'ama', { uploaded: ['ama 1'], queued: ['ama 2', 'ama 3'] }, 1)
			// Kofi's second write never reached the server, and beta.12 dropped its queue entry
			// (the shared vector entry 3, raised by Ama's writes, "covered" it): it reported synced.
			await beta12Database(
				ctx,
				'kofi',
				{ uploaded: ['kofi 1'], queued: [], dropped: ['kofi 2'] },
				3,
			)
			const order = first === 'kofi' ? (['kofi', 'ama'] as const) : (['ama', 'kofi'] as const)
			for (const user of order) {
				const db = ctx.database(user, user === 'ama' ? BROWSER_DEVICE : KOFI_DEVICE)
				await db.open()
				await ctx.settle(db)
			}
			expect(await serverBodies(ctx)).toEqual(['ama 1', 'ama 2', 'ama 3', 'kofi 1', 'kofi 2'])
			expect(submitters(ctx, 'kofi 2')).toEqual(['kofi'])
			expect(ctx.submittedBy.has('kofi 1')).toBe(false)
			await expectEachStoredOnce(ctx)
			const nodeOf = new Map((await storedOps(ctx)).map((op) => [op.body, op.node]))
			expect(nodeOf.get('kofi 2')).toBe(KOFI_DEVICE)
		}, 60_000)
	}
})
