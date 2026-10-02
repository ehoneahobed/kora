/**
 * Resolved-through advertisement, remembered refusals and legacy-pair delivery, at the
 * store and session level, on every built-in store.
 *
 * RT-43: the handshake's own-node entry is the highest sequence the server RESOLVED for
 * the node (stored, validator-ignored, terminally refused, stored under another
 * number), so a device never re-submits an operation the server decided without
 * storing it. RT-45: the own node is always in the handshake vector (0 when the server
 * holds nothing of it). RT-47: a terminally refused id is answered with its original
 * rejection, never judged again, and only for the device that submitted it. RT-48: a
 * version-vector client receives both operations of a legacy pair. Per-user ingest
 * budget: a user cannot multiply the per-node budget by minting node ids.
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { OperationValidator } from '../../src/apply/operation-validator'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import type { KoraSyncServerConfig } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

interface Client {
	messages: SyncMessage[]
	send: (message: SyncMessage) => void
	close: () => void
}
type Login = (nodeId: string, handshake?: Record<string, unknown>) => Promise<Client>

let cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn()
	cleanups = []
})

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let counter = 0
function makeOp(nodeId: string, sequenceNumber: number, title = 't', id?: string): Operation {
	counter += 1
	return {
		id: id ?? `res-op-${nodeId}-${sequenceNumber}-${counter}`,
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: `res-rec-${counter}`,
		data: { title },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: counter, nodeId },
		sequenceNumber,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function batch(ops: Operation[]): SyncMessage {
	return {
		type: 'operation-batch',
		messageId: `b-${Math.random()}`,
		operations: ops,
		isFinal: true,
		batchIndex: 0,
	}
}

let pgSchemas = 0
async function openStore(kind: 'memory' | 'sqlite' | 'postgres'): Promise<ServerStore> {
	if (kind === 'memory') return new MemoryServerStore('server-1')
	if (kind === 'sqlite')
		return createSqliteServerStore({ filename: ':memory:', nodeId: 'server-1' })
	const url = process.env.KORA_PG_TEST_URL as string
	pgSchemas += 1
	const name = `kora_resolutions_${process.pid}_${pgSchemas}`
	const admin = postgres(url, { max: 1, onnotice: () => {} })
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	const client = postgres(url, {
		max: 4,
		idle_timeout: 1,
		onnotice: () => {},
		connection: { search_path: name },
	})
	cleanups.push(async () => {
		await client.end()
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.end()
	})
	return new PostgresServerStore(drizzle(client), 'server-1')
}

async function startServer(
	store: ServerStore,
	extra: Partial<KoraSyncServerConfig> = {},
): Promise<{ server: KoraSyncServer; login: Login }> {
	await store.setSchema(schema)
	const server = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		...extra,
	})
	cleanups.push(async () => {
		await server.stop()
	})
	const login: Login = async (nodeId, handshake = {}) => {
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		server.handleConnection(transport)
		const send = (message: SyncMessage): void => {
			try {
				client.send(message)
			} catch {
				// closed by the server
			}
		}
		send({
			type: 'handshake',
			messageId: `hs-${nodeId}-${Math.random()}`,
			nodeId,
			versionVector: {},
			schemaVersion: schema.version,
			sequenceReservation: true,
			lastDeliverySequence: 0,
			...handshake,
		} as SyncMessage)
		await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
		await tick()
		return { messages, send, close: () => void client.disconnect() }
	}
	return { server, login }
}

function handshakeVector(client: Client): Record<string, number> {
	const response = client.messages.find((m) => m.type === 'handshake-response')
	return (response as unknown as { versionVector: Record<string, number> }).versionVector
}

function rejections(
	messages: SyncMessage[],
): Array<{ operationId: string; code: string; message: string; retriable: boolean }> {
	return messages
		.filter((m) => m.type === 'operation-rejected')
		.map((m) => {
			const r = m as unknown as {
				operationId: string
				code: string
				message: string
				retriable: boolean
			}
			return {
				operationId: r.operationId,
				code: r.code,
				message: r.message,
				retriable: r.retriable,
			}
		})
}

function errors(messages: SyncMessage[]): string[] {
	return messages.filter((m) => m.type === 'error').map((m) => (m as { code: string }).code)
}

async function acked(client: Client, count: number): Promise<void> {
	await vi.waitFor(() =>
		expect(
			client.messages.filter((m) => m.type === 'acknowledgment').length,
		).toBeGreaterThanOrEqual(count),
	)
	await tick()
}

const kinds = [
	'memory',
	'sqlite',
	...(process.env.KORA_PG_TEST_URL ? (['postgres'] as const) : []),
] as const

describe.each(kinds)('operation resolutions: store contract (%s store)', (kind) => {
	test('records are idempotent per id, answered only for their node, and set resolved-through', async () => {
		const store = await openStore(kind)
		await store.setSchema(schema)
		expect(await store.getResolvedThrough?.('n')).toBe(0)
		await store.recordOperationResolution?.({
			operationId: 'op-a',
			nodeId: 'n',
			sequenceNumber: 4,
			outcome: 'refused',
			code: 'INSUFFICIENT_FUNDS',
			message: 'balance too low',
		})
		// The first resolution wins.
		await store.recordOperationResolution?.({
			operationId: 'op-a',
			nodeId: 'n',
			sequenceNumber: 4,
			outcome: 'ignored',
			code: null,
			message: null,
		})
		await store.recordOperationResolution?.({
			operationId: 'op-b',
			nodeId: 'n',
			sequenceNumber: 2,
			outcome: 'ignored',
			code: null,
			message: null,
		})
		expect(await store.getResolvedThrough?.('n')).toBe(4)
		expect(await store.getResolvedThrough?.('other')).toBe(0)
		const found = await store.findOperationResolutions?.('n', ['op-a', 'op-b', 'op-c'])
		expect(found?.get('op-a')).toEqual({
			operationId: 'op-a',
			nodeId: 'n',
			sequenceNumber: 4,
			outcome: 'refused',
			code: 'INSUFFICIENT_FUNDS',
			message: 'balance too low',
		})
		expect(found?.get('op-b')?.outcome).toBe('ignored')
		expect(found?.has('op-c')).toBe(false)
		// Never across nodes: another device asking about the same id learns nothing.
		expect((await store.findOperationResolutions?.('other', ['op-a']))?.size).toBe(0)
	})

	test('a replace-mode import keeps only the resolutions the restored log covers', async () => {
		const store = await openStore(kind)
		await store.setSchema(schema)
		for (let seq = 1; seq <= 3; seq++) await store.applyRemoteOperation(makeOp('n', seq))
		const backup = await store.exportBackup()
		await store.recordOperationResolution?.({
			operationId: 'before',
			nodeId: 'n',
			sequenceNumber: 2,
			outcome: 'ignored',
			code: null,
			message: null,
		})
		await store.recordOperationResolution?.({
			operationId: 'after',
			nodeId: 'n',
			sequenceNumber: 9,
			outcome: 'ignored',
			code: null,
			message: null,
		})
		await store.recordOperationResolution?.({
			operationId: 'unknown-node',
			nodeId: 'gone',
			sequenceNumber: 1,
			outcome: 'refused',
			code: 'X',
			message: 'x',
		})
		await store.importBackup(backup, false)
		// A resolution past the restored log would hide stored ops the restore lost.
		expect(await store.getResolvedThrough?.('n')).toBe(2)
		expect(await store.getResolvedThrough?.('gone')).toBe(0)
		expect((await store.findOperationResolutions?.('n', ['before']))?.size).toBe(1)
	})

	test('a replace-mode import drops stored-elsewhere records whose op the restored log lacks (RT-51)', async () => {
		const store = await openStore(kind)
		await store.setSchema(schema)
		const kept = makeOp('n', 1, 'kept')
		for (const op of [kept, makeOp('n', 2), makeOp('n', 3)]) await store.applyRemoteOperation(op)
		const backup = await store.exportBackup()
		// Both records sit at or below the restored maximum (3).
		for (const operationId of [kept.id, 'lost-by-restore']) {
			await store.recordOperationResolution?.({
				operationId,
				nodeId: 'n',
				sequenceNumber: 2,
				outcome: 'stored-elsewhere',
				code: null,
				message: null,
			})
		}
		await store.recordOperationResolution?.({
			operationId: 'refused-before',
			nodeId: 'n',
			sequenceNumber: 2,
			outcome: 'refused',
			code: 'X',
			message: 'x',
		})
		await store.importBackup(backup, false)
		const found = await store.findOperationResolutions?.('n', [
			kept.id,
			'lost-by-restore',
			'refused-before',
		])
		expect([...(found?.keys() ?? [])].sort()).toEqual([kept.id, 'refused-before'].sort())
	})

	test('deleteOperationResolution forgets one record of its node only', async () => {
		const store = await openStore(kind)
		await store.setSchema(schema)
		await store.recordOperationResolution?.({
			operationId: 'op-d',
			nodeId: 'n',
			sequenceNumber: 7,
			outcome: 'stored-elsewhere',
			code: null,
			message: null,
		})
		await store.deleteOperationResolution?.('other', 'op-d')
		expect((await store.findOperationResolutions?.('n', ['op-d']))?.size).toBe(1)
		await store.deleteOperationResolution?.('n', 'op-d')
		expect((await store.findOperationResolutions?.('n', ['op-d']))?.size).toBe(0)
		expect(await store.getResolvedThrough?.('n')).toBe(0)
	})

	test('legacy pairs are indexed at append and rebuilt by a replace-mode import', async () => {
		const store = await openStore(kind)
		await store.setSchema(schema)
		const x = makeOp('w', 1, 'x')
		const y = makeOp('w', 1, 'y')
		const z = makeOp('w', 2, 'z')
		await store.applyRemoteOperation(x, { legacySequenceWriter: true })
		await store.applyRemoteOperation(y, { legacySequenceWriter: true })
		await store.applyRemoteOperation(z, { legacySequenceWriter: true })
		expect((await store.getSequencePairOperations?.('w', 5))?.map((op) => op.id)).toEqual([
			x.id,
			y.id,
		])
		expect(await store.getSequencePairOperations?.('w', 0)).toEqual([])
		const backup = await store.exportBackup()
		await store.importBackup(backup, false)
		expect((await store.getSequencePairOperations?.('w', 1))?.map((op) => op.id)).toEqual([
			x.id,
			y.id,
		])
	})
})

describe.each(kinds)('operation resolutions: sessions (%s store)', (kind) => {
	test('the handshake always advertises the own node, 0 when the server holds nothing (RT-45)', async () => {
		const store = await openStore(kind)
		const { login } = await startServer(store)
		const c = await login('fresh-device')
		expect(handshakeVector(c)).toEqual({ 'fresh-device': 0 })
		// RT-7 still holds: names the client reports are not echoed.
		const d = await login('another', { versionVector: { 'fresh-device': 3 } })
		expect(handshakeVector(d)['fresh-device']).toBeUndefined()
	})

	test('an ignored op is resolved: advertised, and acknowledged on resubmission without the validator (RT-43)', async () => {
		const store = await openStore(kind)
		const seen = new Map<string, number>()
		const validateOperation: OperationValidator = (op) => {
			seen.set(op.id, (seen.get(op.id) ?? 0) + 1)
			return op.data?.title === 'send' ? { action: 'ignore' } : { action: 'accept' }
		}
		const { login } = await startServer(store, { validateOperation })
		const c = await login('phone')
		const kept = makeOp('phone', 1, 'kept')
		const sent = makeOp('phone', 2, 'send')
		c.send(batch([kept, sent]))
		await acked(c, 1)
		c.close()

		const again = await login('phone')
		expect(handshakeVector(again).phone).toBe(2)
		again.send(batch([sent]))
		await acked(again, 1)
		expect(seen.get(sent.id)).toBe(1)
		expect(rejections(again.messages)).toEqual([])
		expect(store.getVersionVector().get('phone')).toBe(1)
	})

	test('a refused id is answered with its original rejection and never re-judged (RT-47)', async () => {
		const store = await openStore(kind)
		let balance = 50
		let calls = 0
		const validateOperation: OperationValidator = () => {
			calls += 1
			return balance < 100
				? {
						action: 'reject',
						code: 'INSUFFICIENT_FUNDS',
						message: 'balance too low',
						retriable: false,
					}
				: { action: 'accept' }
		}
		const { login } = await startServer(store, { validateOperation })
		const c = await login('teller')
		const withdrawal = makeOp('teller', 1, 'withdraw 100')
		c.send(batch([withdrawal]))
		await acked(c, 1)
		expect(rejections(c.messages)).toEqual([
			{
				operationId: withdrawal.id,
				code: 'INSUFFICIENT_FUNDS',
				message: 'balance too low',
				retriable: false,
			},
		])
		c.close()

		balance = 1_000
		const again = await login('teller')
		// The refused sequence counts as resolved.
		expect(handshakeVector(again).teller).toBe(1)
		again.send(batch([withdrawal]))
		await acked(again, 1)
		expect(rejections(again.messages)).toEqual([
			{
				operationId: withdrawal.id,
				code: 'INSUFFICIENT_FUNDS',
				message: 'balance too low',
				retriable: false,
			},
		])
		expect(calls).toBe(1)
		expect(await store.findStoredOperations?.([withdrawal.id])).toEqual(new Map())
	})

	test('the refusal memory is not an oracle for other nodes', async () => {
		const store = await openStore(kind)
		const auth = {
			authenticate: async (token: string) => ({ userId: token }),
		}
		let calls = 0
		const validateOperation: OperationValidator = (op) => {
			calls += 1
			return op.nodeId === 'alice-phone'
				? { action: 'reject', code: 'SECRET_REASON', message: 'alice detail', retriable: false }
				: { action: 'accept' }
		}
		const { login } = await startServer(store, { validateOperation, auth })
		const alice = await login('alice-phone', { authToken: 'alice' })
		const refused = makeOp('alice-phone', 1, 'a')
		alice.send(batch([refused]))
		await acked(alice, 1)
		expect(rejections(alice.messages).map((r) => r.code)).toEqual(['SECRET_REASON'])

		// Mallory submits an op under her own node that reuses Alice's refused id: it is
		// judged on its own (validator runs), and she never sees Alice's rejection.
		const mallory = await login('mallory-phone', { authToken: 'mallory' })
		mallory.send(batch([makeOp('mallory-phone', 1, 'm', refused.id)]))
		await acked(mallory, 1)
		expect(calls).toBe(2)
		expect(rejections(mallory.messages)).toEqual([])
	})

	test('retriable rejections and SEQUENCE_CONFLICT are not remembered', async () => {
		const store = await openStore(kind)
		let defer = true
		const validateOperation: OperationValidator = (op) =>
			defer && op.data?.title === 'child'
				? { action: 'reject', code: 'PARENT_MISSING', message: 'later', retriable: true }
				: { action: 'accept' }
		const { login } = await startServer(store, { validateOperation })
		const c = await login('dev')
		const child = makeOp('dev', 1, 'child')
		c.send(batch([child]))
		await acked(c, 1)
		expect(rejections(c.messages).map((r) => r.retriable)).toEqual([true])
		defer = false
		c.send(batch([child]))
		await acked(c, 2)
		expect((await store.findStoredOperations?.([child.id]))?.has(child.id)).toBe(true)

		// A different op under a held sequence is refused with SEQUENCE_CONFLICT; renumbered
		// under the same id, it is accepted (the conflict was not remembered as final).
		const clash = makeOp('dev', 1, 'clash')
		c.send(batch([clash]))
		await acked(c, 3)
		expect(rejections(c.messages).at(-1)?.code).toBe('SEQUENCE_CONFLICT')
		c.send(batch([{ ...clash, sequenceNumber: 2 }]))
		await acked(c, 4)
		expect((await store.findStoredOperations?.([clash.id]))?.get(clash.id)?.sequenceNumber).toBe(2)
		expect(handshakeVector(await login('dev')).dev).toBe(2)
	})

	test('an op stored under another sequence counts its submitted sequence as resolved', async () => {
		const store = await openStore(kind)
		const { login } = await startServer(store)
		const c = await login('repair')
		const original = makeOp('repair', 1, 'x')
		c.send(batch([original]))
		await acked(c, 1)
		// The client's sequence repair renumbered it to 3, keeping its id.
		c.send(batch([{ ...original, sequenceNumber: 3 }]))
		await acked(c, 2)
		c.close()
		expect(handshakeVector(await login('repair')).repair).toBe(3)
	})

	test('a stale stored-elsewhere record never acks an unstored op; its real outcome replaces it (RT-51)', async () => {
		const store = await openStore(kind)
		let refuse = false
		const validateOperation: OperationValidator = async () =>
			refuse
				? { action: 'reject', code: 'NOPE', message: 'refused now', retriable: false }
				: { action: 'accept' }
		const { login } = await startServer(store, { validateOperation })
		const stale = makeOp('stale', 1, 'a')
		const other = makeOp('stale', 2, 'b')
		// Records claiming copies the server does not hold (as a restore can leave them).
		for (const op of [stale, other]) {
			await store.recordOperationResolution?.({
				operationId: op.id,
				nodeId: 'stale',
				sequenceNumber: op.sequenceNumber,
				outcome: 'stored-elsewhere',
				code: null,
				message: null,
			})
		}
		const c = await login('stale')
		c.send(batch([stale]))
		await acked(c, 1)
		// Judged normally and stored, not acknowledged as a duplicate of nothing.
		expect((await store.findStoredOperations?.([stale.id]))?.has(stale.id)).toBe(true)
		// A stale record for an op the validator now refuses: the refusal is remembered.
		refuse = true
		c.send(batch([other]))
		await vi.waitFor(() => expect(rejections(c.messages).map((r) => r.code)).toContain('NOPE'))
		expect(
			(await store.findOperationResolutions?.('stale', [other.id]))?.get(other.id)?.outcome,
		).toBe('refused')
		expect((await store.findStoredOperations?.([other.id]))?.has(other.id) ?? false).toBe(false)
	})

	test('a version-vector client receives the second op of a legacy pair it straddles (RT-48)', async () => {
		const store = await openStore(kind)
		const { login } = await startServer(store)
		const writer = await login('beta13', { sequenceReservation: false })
		const x = makeOp('beta13', 1, 'x')
		writer.send(batch([x]))
		await acked(writer, 1)
		const y = makeOp('beta13', 1, 'y')
		writer.send(batch([y]))
		await acked(writer, 2)
		const vectorClient = await login('beta12', {
			lastDeliverySequence: undefined,
			versionVector: { beta13: 1 },
		})
		const delivered = vectorClient.messages.flatMap((m) =>
			m.type === 'operation-batch' ? (m.operations as Operation[]).map((op) => op.id) : [],
		)
		expect(delivered).toEqual(expect.arrayContaining([x.id, y.id]))
	})
})

describe('per-user ingest budget', () => {
	const auth = {
		authenticate: async (token: string) => ({ userId: token }),
	}

	test('minting node ids does not multiply a user budget', async () => {
		const store = new MemoryServerStore('server-1')
		const { login } = await startServer(store, {
			auth,
			maxOpsPerMinute: 3,
			maxOpsPerMinutePerUser: 5,
		})
		const results: string[][] = []
		for (let i = 0; i < 3; i++) {
			const node = `minted-${i}`
			const c = await login(node, { authToken: 'greedy' })
			c.send(batch([makeOp(node, 1), makeOp(node, 2)]))
			await acked(c, 1)
			results.push(errors(c.messages))
		}
		// 2 + 2 within the user's 5; the third node's batch passes its own node budget
		// (2 <= 3) but not the user's.
		expect(results).toEqual([[], [], ['RATE_LIMIT']])
		const stored = await store.findStoredOperations(store.getAllOperations().map((op) => op.id))
		expect(stored.size).toBe(5)
	})

	test('other users and one device per node keep their own budgets', async () => {
		const store = new MemoryServerStore('server-1')
		const { login } = await startServer(store, { auth, maxOpsPerMinute: 2 })
		// Default user budget: 4 x the node budget.
		const a = await login('a-1', { authToken: 'ann' })
		a.send(batch([makeOp('a-1', 1), makeOp('a-1', 2), makeOp('a-1', 3)]))
		await acked(a, 1)
		expect(errors(a.messages)).toEqual(['RATE_LIMIT'])
		// A node over its own budget did not drain the user's: a sibling still has 2.
		const a2 = await login('a-2', { authToken: 'ann' })
		a2.send(batch([makeOp('a-2', 1), makeOp('a-2', 2)]))
		await acked(a2, 1)
		expect(errors(a2.messages)).toEqual([])
		const b = await login('b-1', { authToken: 'bob' })
		b.send(batch([makeOp('b-1', 1), makeOp('b-1', 2)]))
		await acked(b, 1)
		expect(errors(b.messages)).toEqual([])
	})

	test('0 disables the per-user budget', async () => {
		const store = new MemoryServerStore('server-1')
		const { login } = await startServer(store, {
			auth,
			maxOpsPerMinute: 2,
			maxOpsPerMinutePerUser: 0,
		})
		for (let i = 0; i < 6; i++) {
			const node = `n-${i}`
			const c = await login(node, { authToken: 'many' })
			c.send(batch([makeOp(node, 1), makeOp(node, 2)]))
			await acked(c, 1)
			expect(errors(c.messages)).toEqual([])
		}
	})

	test('a negative per-user budget is refused at construction', () => {
		expect(
			() => new KoraSyncServer({ store: new MemoryServerStore(), maxOpsPerMinutePerUser: -1 }),
		).toThrow(/maxOpsPerMinutePerUser/)
	})
})
