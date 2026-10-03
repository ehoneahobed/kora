import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation, OperationTransform, SchemaDefinition } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { KoraSyncServerConfig } from '../types'

/**
 * Protocol v2 ingest (D2, CORE-1, ENC-3, NEW-ENC-1): the server verifies plaintext
 * version-2 ids BEFORE any schema transform, stores envelope operations opaquely,
 * strips server-authored metadata from uploads, advertises protocol 2 with its
 * authoritative node ids, and serves protocol-1 clients with a deprecation warning.
 */
const schemaV1 = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})
const schemaV2 = defineSchema({
	version: 2,
	collections: { notes: { fields: { title: t.string(), tag: t.string().optional() } } },
})

async function note(
	nodeId: string,
	seq: number,
	overrides: Partial<Parameters<typeof createOperation>[0]> = {},
	hashVersion: 1 | 2 = 2,
): Promise<Operation> {
	return createOperation(
		{
			nodeId,
			type: 'insert',
			collection: 'notes',
			recordId: `rec-${nodeId}-${seq}`,
			data: { title: `t${seq}` },
			previousData: null,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: 1,
			...overrides,
		},
		new HybridLogicalClock(nodeId),
		{ hashVersion },
	)
}

async function setup(
	extra: Partial<KoraSyncServerConfig> = {},
	schema: SchemaDefinition = schemaV1,
	storeAuthoritativeNodeIds?: string[],
): Promise<{
	store: MemoryServerStore
	login: (
		nodeId: string,
		handshake?: Record<string, unknown>,
	) => Promise<{ send: (m: SyncMessage) => void; messages: SyncMessage[] }>
}> {
	const store = new MemoryServerStore(
		'server-1',
		storeAuthoritativeNodeIds ? { authoritativeNodeIds: storeAuthoritativeNodeIds } : undefined,
	)
	await store.setSchema(schema)
	const server = new KoraSyncServer({ store, ...extra })
	const login = async (nodeId: string, handshake: Record<string, unknown> = {}) => {
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		server.handleConnection(transport)
		client.send({
			type: 'handshake',
			messageId: `hs-${nodeId}`,
			nodeId,
			versionVector: {},
			schemaVersion: schema.version,
			sequenceReservation: true,
			protocolVersion: 2,
			...handshake,
		} as SyncMessage)
		await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
		return { send: (m: SyncMessage) => client.send(m), messages }
	}
	return { store, login }
}

function batch(ops: Operation[], id: string): SyncMessage {
	return { type: 'operation-batch', messageId: id, operations: ops, isFinal: true, batchIndex: 0 }
}

async function acked(messages: SyncMessage[], id: string): Promise<void> {
	await vi.waitFor(() =>
		expect(
			messages.some((m) => m.type === 'acknowledgment' && m.acknowledgedMessageId === id),
		).toBe(true),
	)
}

function rejections(messages: SyncMessage[]) {
	return messages.flatMap((m) => (m.type === 'operation-rejected' ? [m] : []))
}

describe('protocol v2 handshake', () => {
	test('the response advertises protocol 2 and the authoritative node ids', async () => {
		const { login } = await setup()
		const c = await login('dev-a')
		const response = c.messages.find((m) => m.type === 'handshake-response')
		if (response?.type !== 'handshake-response') throw new Error('no response')
		expect(response.protocolVersion).toBe(2)
		// Only explicit ids: the configured legacy id (RT-62). The store's own
		// kora:server: id is authoritative by prefix and not listed (RT-75).
		expect(response.authoritativeNodeIds).toEqual(['server-1'])
	})

	test('the handshake sends exactly the explicit node ids the store folds with', async () => {
		const { login, store } = await setup({}, schemaV1, ['srv-a', 'srv-b'])
		expect(store.getAuthoritativeNodeIds()).toEqual([
			store.getNodeId(),
			'server-1',
			'srv-a',
			'srv-b',
		])
		const c = await login('dev-a')
		const response = c.messages.find((m) => m.type === 'handshake-response')
		// The kora:server: ids are authoritative by prefix on every replica (RT-75).
		expect(response?.type === 'handshake-response' && response.authoritativeNodeIds).toEqual(
			store.getAuthoritativeNodeIds().filter((id) => !id.startsWith('kora:server:')),
		)
	})

	test('a protocol-1 client is accepted with a deprecation warning', async () => {
		const warnings: unknown[] = []
		const { login, store } = await setup({
			logger: { log: (entry: { event: string }) => warnings.push(entry.event) } as never,
		})
		const c = await login('dev-old', { protocolVersion: undefined, sequenceReservation: undefined })
		const response = c.messages.find((m) => m.type === 'handshake-response')
		expect(response?.type === 'handshake-response' && response.accepted).toBe(true)
		expect(warnings).toContain('session.protocol_deprecated')
		// Its version-1 operations are stored as before.
		const legacy = await note('dev-old', 1, {}, 1)
		c.send(batch([legacy], 'b-old'))
		await acked(c.messages, 'b-old')
		expect(store.getAllOperations().map((o) => o.id)).toContain(legacy.id)
	})
})

describe('CORE-1: server verification of uploaded ids', () => {
	const tampers: Array<[string, (op: Operation) => Operation]> = [
		['previousData', (op) => ({ ...op, previousData: { title: 'x' } })],
		['sequenceNumber', (op) => ({ ...op, sequenceNumber: op.sequenceNumber + 1 })],
		['causalDeps', (op) => ({ ...op, causalDeps: ['forged'] })],
		['id', (op) => ({ ...op, id: 'f'.repeat(64) })],
	]
	for (const [field, tamper] of tampers) {
		test(`a version-2 op with a rewritten ${field} is refused non-retriably, never stored`, async () => {
			const { login, store } = await setup()
			const c = await login('dev-a')
			const forged = tamper(await note('dev-a', 1))
			c.send(batch([forged], 'b1'))
			await acked(c.messages, 'b1')
			const [rejection] = rejections(c.messages)
			expect(rejection).toMatchObject({ code: 'INVALID_OPERATION_ID', retriable: false })
			expect(store.getAllOperations().some((o) => o.id === forged.id)).toBe(false)
		})
	}

	test('a valid version-2 op is stored with its hash version', async () => {
		const { login, store } = await setup()
		const c = await login('dev-a')
		const op = await note('dev-a', 1)
		c.send(batch([op], 'b1'))
		await acked(c.messages, 'b1')
		expect(rejections(c.messages)).toEqual([])
		expect(store.getAllOperations().find((o) => o.id === op.id)?.hashVersion).toBe(2)
	})

	test('an unknown declared hash version is refused', async () => {
		const { login } = await setup()
		const c = await login('dev-a')
		const op = { ...(await note('dev-a', 1)), hashVersion: 7 } as unknown as Operation
		c.send(batch([op], 'b1'))
		await acked(c.messages, 'b1')
		expect(rejections(c.messages)[0]?.code).toBe('INVALID_OPERATION_ID')
	})

	test('verification runs before the schema transform; the transformed copy is stored as version 1', async () => {
		const transforms: OperationTransform[] = [
			{
				fromVersion: 1,
				toVersion: 2,
				transform: (op) => ({ ...op, data: { ...op.data, tag: 'migrated' }, schemaVersion: 2 }),
			},
		]
		const { login, store } = await setup(
			{
				schemaVersion: 2,
				supportedSchemaVersions: { min: 1, max: 2 },
				operationTransforms: transforms,
			},
			schemaV2,
		)
		const c = await login('dev-v1', { schemaVersion: 1 })
		const op = await note('dev-v1', 1)
		c.send(batch([op], 'b1'))
		await acked(c.messages, 'b1')
		expect(rejections(c.messages)).toEqual([])
		const stored = store.getAllOperations().find((o) => o.id === op.id)
		expect(stored?.data).toEqual({ title: 't1', tag: 'migrated' })
		// Rewritten under the original id: no longer a version-2 content hash.
		expect(stored?.hashVersion).toBeUndefined()
	})

	test('RT-64: an op without hashVersion is verified as version 1; a chosen id is refused', async () => {
		const { login, store } = await setup()
		const c = await login('dev-a')
		const { hashVersion: _v, ...honest } = await note('dev-a', 1, {}, 1)
		const forged: Operation = { ...(await note('dev-a', 2, {}, 1)), id: 'f'.repeat(64) }
		const { hashVersion: _f, ...forgedNoVersion } = forged
		c.send(batch([honest as Operation, forgedNoVersion as Operation], 'b1'))
		await acked(c.messages, 'b1')
		expect(rejections(c.messages).map((r) => [r.operationId, r.code])).toEqual([
			['f'.repeat(64), 'INVALID_OPERATION_ID'],
		])
		// Verified as version 1: stored declaring it, so receivers verify it too.
		expect(store.getAllOperations().find((o) => o.id === honest.id)?.hashVersion).toBe(1)
		expect(store.getAllOperations().some((o) => o.id === forged.id)).toBe(false)
		// A peer receives the declared version.
		const peer = await login('dev-b')
		await vi.waitFor(() =>
			expect(
				peer.messages.some(
					(m) =>
						m.type === 'operation-batch' &&
						m.operations.some((o) => o.id === honest.id && o.hashVersion === 1),
				),
			).toBe(true),
		)
	})
})

describe('server-authored metadata and the encryption envelope', () => {
	test('foldState and fieldVersions are stripped from device uploads', async () => {
		const { login, store } = await setup()
		const c = await login('dev-a')
		const op = await note('dev-a', 1)
		const forged = {
			...op,
			foldState: '{"forged":true}',
			fieldVersions: { title: { wallTime: 9e12, logical: 0, nodeId: 'x' } },
		}
		c.send(batch([forged], 'b1'))
		await acked(c.messages, 'b1')
		const stored = store.getAllOperations().find((o) => o.id === op.id)
		expect(stored).toBeDefined()
		expect(stored?.foldState).toBeUndefined()
		expect(stored?.fieldVersions).toBeUndefined()
	})

	test('NEW-ENC-1: an envelope op is stored opaquely by a schema-aware server and relayed intact', async () => {
		const { login, store } = await setup()
		const a = await login('dev-a')
		const b = await login('dev-b')
		const plain = await note('dev-a', 1)
		const sealed: Operation = {
			...plain,
			data: null,
			encrypted: {
				v: 2,
				alg: 'aes-256-gcm',
				keyId: 'k1-0011223344556677',
				keyVersion: 1,
				data: { iv: 'aXY=', ct: 'Y3Q=' },
				previousData: { iv: 'aXY=', ct: 'bnVsbA==' },
			},
		}
		a.send(batch([sealed], 'b1'))
		await acked(a.messages, 'b1')
		expect(rejections(a.messages)).toEqual([])
		expect(store.getAllOperations().find((o) => o.id === plain.id)?.encrypted).toEqual(
			sealed.encrypted,
		)
		await vi.waitFor(() => {
			const relayed = b.messages
				.flatMap((m) => (m.type === 'operation-batch' ? m.operations : []))
				.find((o) => o.id === plain.id)
			expect(relayed?.encrypted).toEqual(sealed.encrypted)
			expect(relayed?.data).toBeNull()
		})
	})

	test('with required encryption, a plaintext upload is refused unless migrating', async () => {
		const strict = await setup({ encryption: { required: true } })
		const c = await strict.login('dev-a')
		c.send(batch([await note('dev-a', 1)], 'b1'))
		await acked(c.messages, 'b1')
		expect(rejections(c.messages)[0]).toMatchObject({
			code: 'PLAINTEXT_REJECTED',
			retriable: false,
		})

		const migrating = await setup({
			encryption: { required: true, allowPlaintextMigration: true },
		})
		const m = await migrating.login('dev-a')
		m.send(batch([await note('dev-a', 1)], 'b1'))
		await acked(m.messages, 'b1')
		expect(rejections(m.messages)).toEqual([])
	})
})
