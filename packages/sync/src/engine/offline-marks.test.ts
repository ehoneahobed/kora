import type {
	OfflineCompletion,
	OfflineCompletionMark,
	OfflineMarksSnapshot,
	OfflineUnitKey,
	Operation,
	VersionVector,
} from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { OperationBatchMessage, SerializedOperation, SyncMessage } from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import { type MemoryTransport, createMemoryTransportPair } from '../transport/memory-transport'
import type { SyncConfig, SyncStatePersistence } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

/**
 * Completion marks and delivery-unit keys (offline-readiness design 4.1), driven through the
 * engine over a memory transport with a persistence fake that mirrors the store's rules.
 * "Restart" is a new engine over the same persistence, loading marks without a connection.
 */

const serializer = new JsonMessageSerializer()

function makeOp(id: string, seq: number): Operation {
	return {
		id,
		nodeId: 'server',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: id },
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: 'server' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function batch(
	messageId: string,
	ops: Operation[],
	base: number | undefined,
	max: number | undefined,
	isFinal: boolean,
	extra: Partial<OperationBatchMessage> = {},
): OperationBatchMessage {
	return {
		type: 'operation-batch',
		messageId,
		operations: ops.map((o): SerializedOperation => serializer.encodeOperation(o)),
		isFinal,
		batchIndex: 0,
		...(base === undefined ? {} : { baseDeliverySequence: base }),
		...(max === undefined ? {} : { maxDeliverySequence: max }),
		...extra,
	}
}

interface FakeState extends SyncStatePersistence {
	watermarks: Map<string, number>
	marks: Map<string, OfflineCompletionMark>
	units: Map<string, OfflineUnitKey>
	completions: OfflineCompletion[]
	durable: { promise: Promise<void> | null }
	accessKey: { value: string | null }
}

function createState(): FakeState {
	const watermarks = new Map<string, number>()
	const marks = new Map<string, OfflineCompletionMark>()
	const units = new Map<string, OfflineUnitKey>()
	const completions: OfflineCompletion[] = []
	const durable: { promise: Promise<void> | null } = { promise: null }
	const accessKey: { value: string | null } = { value: null }
	return {
		watermarks,
		marks,
		units,
		completions,
		durable,
		accessKey,
		loadLastAckedServerVector: async () => new Map<string, number>(),
		saveLastAckedServerVector: async () => {},
		mergeServerVectors: (a: VersionVector, b: VersionVector) => new Map([...a, ...b]),
		countUnsyncedOperations: async () => 0,
		getUnsyncedOperations: async () => [],
		loadAllDeliveryWatermarks: async () => Object.fromEntries(watermarks),
		loadDeliveryWatermark: async (signature) => watermarks.get(signature) ?? 0,
		saveDeliveryWatermark: async (signature, watermark, completion) => {
			watermarks.set(signature, watermark)
			if (!completion) return
			completions.push(completion)
			const existing = marks.get(signature)
			if (!existing || existing.watermark <= completion.mark.watermark) {
				marks.set(signature, completion.mark)
			}
			if (completion.unitId !== null) {
				for (const [key, unit] of units) {
					if (unit.signature === signature && unit.unitId === completion.unitId) units.delete(key)
				}
			}
			for (const [key, unit] of units) {
				if (unit.signature === signature && unit.upTo <= completion.mark.watermark) {
					units.delete(key)
				}
			}
		},
		deleteDeliveryWatermark: async (signature) => {
			watermarks.delete(signature)
			marks.delete(signature)
		},
		openOfflineUnit: async (unit) => {
			units.set(`${unit.signature}:${unit.unitId}`, unit)
		},
		clearOfflineMarks: async () => {
			marks.clear()
		},
		loadOfflineMarks: async (): Promise<OfflineMarksSnapshot> => ({
			marks: [...marks.values()],
			units: [...units.values()],
		}),
		loadAccessRulesKey: async () => accessKey.value,
		saveAccessRulesKey: async (key) => {
			accessKey.value = key
		},
		whenPersisted: () => durable.promise,
	}
}

function createStore(apply?: SyncStore['applyRemoteOperation']): SyncStore {
	const versionVector: VersionVector = new Map()
	return {
		getVersionVector: () => versionVector,
		getNodeId: () => 'client-node',
		applyRemoteOperation: apply ?? vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
	}
}

interface Running {
	engine: SyncEngine
	server: MemoryTransport
	sent: SyncMessage[]
}

async function run(
	state: SyncStatePersistence,
	store: SyncStore = createStore(),
	config: Partial<SyncConfig> = {},
	handshake: Record<string, unknown> = {},
): Promise<Running> {
	const { client, server } = createMemoryTransportPair()
	const sent: SyncMessage[] = []
	server.onMessage((msg) => {
		sent.push(msg)
		if (msg.type === 'handshake') {
			server.send({
				type: 'handshake-response',
				messageId: `resp-${msg.messageId}`,
				nodeId: 'server-node',
				versionVector: {},
				schemaVersion: msg.schemaVersion,
				accepted: true,
				...handshake,
			})
		}
	})
	const engine = new SyncEngine({
		transport: client,
		store,
		config: { url: 'ws://test', ...config },
		syncState: state,
	})
	await engine.start()
	await vi.waitFor(() => expect(engine.getState()).toBe('syncing'))
	return { engine, server, sent }
}

/** A new engine over the same persistence, offline: start() loads state, connect fails. */
async function restart(state: SyncStatePersistence, config: Partial<SyncConfig> = {}) {
	const { client } = createMemoryTransportPair()
	client.connect = async () => {
		throw new Error('offline')
	}
	const engine = new SyncEngine({
		transport: client,
		store: createStore(),
		config: { url: 'ws://test', ...config },
		syncState: state,
	})
	await engine.start().catch(() => {})
	return engine
}

const settled = (engine: SyncEngine, watermark: number) =>
	vi.waitFor(() => expect(engine.getStatus().deliveryWatermark).toBe(watermark))

describe('completion marks', () => {
	test('a fully applied final batch sets the mark with the watermark; a non-final one does not', async () => {
		const state = createState()
		const { engine, server } = await run(state)

		server.send(batch('b1', [makeOp('o1', 1)], 0, 5, false))
		await settled(engine, 5)
		expect(state.marks.size).toBe(0)
		expect(engine.getOfflineData().state).not.toBe('complete')

		server.send(batch('b2', [makeOp('o2', 2)], 5, 9, true))
		await settled(engine, 9)
		const mark = state.marks.get('')
		expect(mark?.watermark).toBe(9)
		expect(engine.getOfflineData().state).toBe('complete')
		expect(engine.getOfflineData().completedAt).toBe(mark?.at)
		await engine.stop()
	})

	test('a restart with no connection still reads complete from the stored mark', async () => {
		const state = createState()
		const { engine, server } = await run(state)
		server.send(batch('b1', [makeOp('o1', 1)], 0, 4, true))
		await settled(engine, 4)
		await engine.stop()

		const restarted = await restart(state)
		expect(restarted.getOfflineData()).toMatchObject({ state: 'complete', sessionLive: false })
	})

	test('no mark on a gap, a blocked failure or a legacy batch', async () => {
		const state = createState()
		let calls = 0
		const store = createStore(async () => {
			calls++
			if (calls === 1) throw new Error('transient apply failure')
			return 'applied' as const
		})
		const { engine, server } = await run(state, store)

		server.send(batch('gap', [makeOp('g', 9)], 5, 9, true))
		server.send(batch('fail', [makeOp('f', 1)], 0, 3, true))
		await vi.waitFor(() => expect(calls).toBeGreaterThan(0))
		server.send(batch('legacy', [makeOp('l', 2)], undefined, undefined, true))
		await vi.waitFor(() => expect(calls).toBeGreaterThan(1))

		expect(state.marks.size).toBe(0)
		expect(engine.getOfflineData().state).not.toBe('complete')
		expect(engine.getOfflineData().blocked).toBe(true)
		await engine.stop()
	})

	test('a narrowing batch clears every mark before anything is applied', async () => {
		const state = createState()
		const first = await run(state)
		first.server.send(batch('b1', [makeOp('o1', 1)], 0, 4, true))
		await settled(first.engine, 4)
		await first.engine.stop()
		expect(state.marks.size).toBe(1)

		const store = createStore()
		store.applyCollectionNarrowing = async () => {
			throw new Error('crash inside the narrowing')
		}
		const second = await run(state, store)
		second.server.send(
			batch('n1', [], 4, 8, true, {
				accessNarrowing: { todos: { where: { owner: 'x' } } },
			} as never),
		)
		await vi.waitFor(() => expect(state.marks.size).toBe(0))
		await second.engine.stop()

		expect((await restart(state)).getOfflineData().state).toBe('incomplete')
	})

	test('a retraction clears every mark', async () => {
		const state = createState()
		const first = await run(state)
		first.server.send(batch('b1', [makeOp('o1', 1)], 0, 4, true))
		await settled(first.engine, 4)
		expect(state.marks.size).toBe(1)

		first.server.send(
			batch('r1', [makeOp('o2', 2)], 4, 6, true, {
				retractions: [{ collection: 'todos', recordId: 'rec-o1', afterOperationIndex: 0 }],
			} as never),
		)
		await vi.waitFor(() => expect(state.marks.size).toBeLessThanOrEqual(1))
		await first.engine.stop()
		expect(state.completions.length).toBeGreaterThanOrEqual(1)
	})

	test('a watermark ahead of the server frontier (restore, forceFullResync) clears the marks', async () => {
		const state = createState()
		const first = await run(state)
		first.server.send(batch('b1', [makeOp('o1', 1)], 0, 50, true))
		await settled(first.engine, 50)
		await first.engine.stop()
		expect(state.marks.size).toBe(1)

		const second = await run(state, createStore(), {}, { serverMaxDeliverySequence: 10 })
		await vi.waitFor(() => expect(state.marks.size).toBe(0))
		expect(second.engine.getOfflineData().state).not.toBe('complete')
		await second.engine.stop()
	})

	test('rules key, scope, principal and synced-collection mismatches are not complete', async () => {
		const state = createState()
		const base: Partial<SyncConfig> = { principal: async () => 'u1', syncedCollections: ['todos'] }
		const first = await run(state, createStore(), base)
		first.server.send(batch('b1', [makeOp('o1', 1)], 0, 4, true, { accessRulesKey: 'k1' }))
		await settled(first.engine, 4)
		await first.engine.stop()
		expect(state.marks.get('')?.rulesKey).toBe('k1')

		expect((await restart(state, base)).getOfflineData().state).toBe('complete')
		// A mark under other rules, another user, or a larger synced set proves nothing.
		const otherUser = await restart(state, { ...base, principal: async () => 'u2' })
		const otherSet = await restart(state, { ...base, syncedCollections: ['todos', 'notes'] })
		state.accessKey.value = 'k2'
		const otherRules = await restart(state, base)
		expect(otherSet.getOfflineData().state).toBe('incomplete')
		expect(otherRules.getOfflineData().state).toBe('incomplete')
		expect(otherUser.getOfflineData().state).toBe('incomplete')
	})

	test('IndexedDB-style persistence: not complete until the barrier resolves', async () => {
		const state = createState()
		let release: () => void = () => {}
		state.durable.promise = new Promise<void>((resolve) => {
			release = resolve
		})
		const { engine, server } = await run(state)
		const events: string[] = []
		engine.onStatusChange(() => events.push(engine.getOfflineData().state))
		server.send(batch('b1', [makeOp('o1', 1)], 0, 4, true))
		await settled(engine, 4)
		expect(state.marks.size).toBe(1)
		expect(engine.getOfflineData().state).toBe('syncing')

		release()
		await vi.waitFor(() => expect(engine.getOfflineData().state).toBe('complete'))
		await engine.stop()
	})
})

describe('delivery units', () => {
	/** A store with no transactional batching and an apply that can be held. */
	function heldStore(hold: { release: (() => void) | null }): SyncStore {
		let calls = 0
		return createStore(async () => {
			calls++
			if (calls === 2)
				await new Promise<void>((resolve) => {
					hold.release = resolve
				})
			return 'applied' as const
		})
	}

	test('a crash mid-unit leaves the unit key, and a restart is never complete', async () => {
		const state = createState()
		const first = await run(state)
		first.server.send(batch('b1', [makeOp('o1', 1)], 0, 5, true))
		await settled(first.engine, 5)
		await first.engine.stop()
		expect(state.marks.get('')?.watermark).toBe(5)

		// An ordinary non-final batch applies one operation and the process dies.
		const hold: { release: (() => void) | null } = { release: null }
		const second = await run(state, heldStore(hold))
		second.server.send(batch('b2', [makeOp('o2', 2), makeOp('o3', 3)], 5, 9, false))
		await vi.waitFor(() => expect(hold.release).not.toBeNull())
		expect(state.units.size).toBe(1)
		const [unit] = [...state.units.values()]
		expect(unit?.upTo).toBeGreaterThanOrEqual(9)
		await second.engine.destroy()

		const restarted = await restart(state)
		expect(restarted.getOfflineData().state).toBe('incomplete')
	})

	test('the unit key leaves with the final batch, and a later unit covering it clears a crashed one', async () => {
		const state = createState()
		state.units.set('x', { signature: '', unitId: 'crashed.0', base: 0, upTo: 8 })
		const { engine, server } = await run(state)
		expect(engine.getOfflineData().state).not.toBe('complete')

		server.send(batch('b1', [makeOp('o1', 1)], 0, 8, true))
		await settled(engine, 8)
		expect(state.units.size).toBe(0)
		expect(engine.getOfflineData().state).toBe('complete')
		await engine.stop()
	})

	test('a unit that does not cover a crashed key leaves it, so the view stays incomplete', async () => {
		const state = createState()
		state.units.set('x', { signature: '', unitId: 'crashed.0', base: 0, upTo: 20 })
		const { engine, server } = await run(state)
		server.send(batch('b1', [makeOp('o1', 1)], 0, 8, true))
		await settled(engine, 8)
		expect(state.units.size).toBe(1)
		expect(engine.getOfflineData().state).not.toBe('complete')
		await engine.stop()
	})

	test('two engines on one view: a newer unit that stalls keeps the view incomplete in every engine', async () => {
		const state = createState()
		const hold: { release: (() => void) | null } = { release: null }
		const a = await run(state, heldStore(hold))
		a.server.send(batch('a1', [makeOp('a1', 1), makeOp('a2', 2)], 0, 20, false))
		await vi.waitFor(() => expect(hold.release).not.toBeNull())
		expect(state.units.size).toBe(1)

		// Another tab finishes an older unit while A is stalled mid-unit.
		const b = await run(state)
		b.server.send(batch('b1', [makeOp('b1', 3)], 0, 10, true))
		await settled(b.engine, 10)
		expect(state.marks.get('')?.watermark).toBe(10)
		expect(state.units.size).toBe(1)
		expect(b.engine.getOfflineData().state).not.toBe('complete')

		await a.engine.destroy()
		await b.engine.destroy()
		const third = await restart(state)
		expect(third.getOfflineData().state).toBe('incomplete')
	})

	test('a batch that commits in one transaction opens no unit key and sets the mark inside it', async () => {
		const state = createState()
		state.saveQuarantine = async () => {}
		const identity = {}
		state.storageIdentity = () => identity
		const store = createStore()
		store.storageIdentity = () => identity
		store.applyDeliveryBatch = async (fn) => ({
			value: await fn({
				applyRemoteOperation: async () => 'applied' as const,
				applyScopeRetraction: async () => {},
				saveQuarantine: async () => {},
				saveDeliveryWatermark: (signature, watermark, completion) =>
					state.saveDeliveryWatermark?.(signature, watermark, completion) ?? Promise.resolve(),
				afterCommit: () => {},
			}),
		})
		const { engine, server } = await run(state, store)
		server.send(batch('b1', [makeOp('o1', 1)], 0, 3, false))
		await settled(engine, 3)
		expect(state.units.size).toBe(0)
		expect(state.marks.size).toBe(0)

		server.send(batch('b2', [makeOp('o2', 2)], 3, 6, true))
		await settled(engine, 6)
		expect(state.units.size).toBe(0)
		expect(state.marks.get('')?.watermark).toBe(6)
		await engine.stop()
	})
})

describe('pins in the sync view (app.offline.keep)', () => {
	const subset = (collection: string, where: Record<string, unknown>) => ({ collection, where })

	function bareEngine(config: Partial<SyncConfig> = {}): SyncEngine {
		const { client } = createMemoryTransportPair()
		return new SyncEngine({
			transport: client,
			store: createStore(),
			config: { url: 'ws://test', ...config },
			syncState: createState(),
		})
	}

	test('a pin widens a collection a live query restricts, and never narrows an unrestricted one', () => {
		const engine = bareEngine()
		engine.setPinQuerySubsets([subset('todos', { list: 'b' }), subset('notes', { tag: 'x' })])
		// Nothing restricts any collection: everything is delivered, pins add nothing.
		expect(engine.getActiveQuerySubsets()).toEqual([])

		const off = engine.registerQuerySubset(subset('todos', { list: 'a' }))
		expect(engine.getActiveQuerySubsets()).toEqual(
			expect.arrayContaining([subset('todos', { list: 'a' }), subset('todos', { list: 'b' })]),
		)
		expect(engine.getActiveQuerySubsets().some((s) => s.collection === 'notes')).toBe(false)

		off()
		expect(engine.getActiveQuerySubsets()).toEqual([])
	})

	test('static mode: pins widen the manifest; disabled mode: no subsets at all', () => {
		const fixed = bareEngine({ querySubsets: { mode: 'static' } })
		fixed.setQuerySubsets([subset('todos', { list: 'a' })])
		fixed.setPinQuerySubsets([subset('todos', { list: 'b' }), subset('notes', {})])
		expect(fixed.getActiveQuerySubsets()).toEqual(
			expect.arrayContaining([subset('todos', { list: 'a' }), subset('todos', { list: 'b' })]),
		)
		expect(fixed.getActiveQuerySubsets()).toHaveLength(2)

		const off = bareEngine({ querySubsets: { mode: 'disabled' } })
		off.setPinQuerySubsets([subset('todos', { list: 'b' })])
		expect(off.getActiveQuerySubsets()).toEqual([])
	})

	test('a pin whose where matches the whole collection makes it unrestricted', () => {
		const engine = bareEngine()
		engine.registerQuerySubset(subset('todos', { list: 'a' }))
		engine.setPinQuerySubsets([subset('todos', {})])
		expect(engine.getActiveQuerySubsets()).toEqual([subset('todos', {})])
	})

	async function runPinned(state: FakeState, pins: Array<ReturnType<typeof subset>>) {
		const { client, server } = createMemoryTransportPair()
		const sent: SyncMessage[] = []
		server.onMessage((msg) => {
			sent.push(msg)
			if (msg.type === 'handshake') {
				server.send({
					type: 'handshake-response',
					messageId: `resp-${msg.messageId}`,
					nodeId: 'server-node',
					versionVector: {},
					schemaVersion: msg.schemaVersion,
					accepted: true,
				})
			}
		})
		const engine = new SyncEngine({
			transport: client,
			store: createStore(),
			config: { url: 'ws://test' },
			syncState: state,
		})
		engine.registerQuerySubset(subset('todos', { list: 'a' }))
		engine.setPinQuerySubsets(pins)
		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('syncing'))
		return { engine, server, sent }
	}

	async function restartPinned(state: FakeState, pins: Array<ReturnType<typeof subset>>) {
		const { client } = createMemoryTransportPair()
		client.connect = async () => {
			throw new Error('offline')
		}
		const engine = new SyncEngine({
			transport: client,
			store: createStore(),
			config: { url: 'ws://test' },
			syncState: state,
		})
		engine.registerQuerySubset(subset('todos', { list: 'a' }))
		engine.setPinQuerySubsets(pins)
		await engine.start().catch(() => {})
		return engine
	}

	test('the handshake names the pinned subsets, and completeness is judged over them', async () => {
		const state = createState()
		const first = await runPinned(state, [subset('todos', { list: 'b' })])
		const handshake = first.sent.find((msg) => msg.type === 'handshake') as
			| { syncQueries?: Array<{ collection: string; where: Record<string, unknown> }> }
			| undefined
		expect(handshake?.syncQueries).toEqual(
			expect.arrayContaining([subset('todos', { list: 'a' }), subset('todos', { list: 'b' })]),
		)
		first.server.send(batch('b1', [makeOp('o1', 1)], 0, 4, true))
		await settled(first.engine, 4)
		await first.engine.stop()

		// The same view offline is complete; a mark that does not cover a new pin is not.
		const same = await restartPinned(state, [subset('todos', { list: 'b' })])
		expect(same.getOfflineData().state).toBe('complete')
		const without = await restartPinned(state, [])
		expect(without.getOfflineData().state).toBe('complete')
		const widened = await restartPinned(state, [
			subset('todos', { list: 'b' }),
			subset('todos', { list: 'c' }),
		])
		expect(widened.getOfflineData().state).toBe('incomplete')
	})
})
