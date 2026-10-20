import { generateFullDDL } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SqliteWasmAdapter } from '../../src/adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import { BridgeTerminatedError } from '../../src/errors'
import {
	FollowerBroadcastBridge,
	TransactionSerializingWorkerBridge,
	startLeaderRpcRelay,
} from '../../src/multi-tab/tab-storage'
import { minimalSchema } from '../fixtures/test-schema'

type ChannelHandler = (event: { data: unknown }) => void

class MockBroadcastChannel {
	static channels = new Map<string, Set<MockBroadcastChannel>>()
	private readonly handlers = new Set<ChannelHandler>()

	constructor(public readonly name: string) {
		const set = MockBroadcastChannel.channels.get(name) ?? new Set()
		set.add(this)
		MockBroadcastChannel.channels.set(name, set)
	}

	postMessage(data: unknown): void {
		const set = MockBroadcastChannel.channels.get(this.name) ?? new Set()
		for (const peer of set) {
			if (peer !== this) {
				for (const handler of peer.handlers) {
					handler({ data })
				}
			}
		}
	}

	addEventListener(_type: 'message', handler: ChannelHandler): void {
		this.handlers.add(handler)
	}

	removeEventListener(_type: 'message', handler: ChannelHandler): void {
		this.handlers.delete(handler)
	}

	close(): void {
		MockBroadcastChannel.channels.get(this.name)?.delete(this)
	}
}

const INSERT =
	'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, 0, 1, 1)'

async function openWorker(): Promise<MockWorkerBridge> {
	const worker = new MockWorkerBridge()
	const response = await worker.send({
		id: 0,
		type: 'open',
		ddlStatements: generateFullDDL(minimalSchema),
	})
	expect(response.type).toBe('success')
	return worker
}

async function ids(worker: MockWorkerBridge): Promise<string[]> {
	const response = await worker.send({
		id: 0,
		type: 'query',
		sql: 'SELECT id FROM todos ORDER BY id',
	})
	if (response.type !== 'success') throw new Error(response.message)
	return (response.data as Array<{ id: string }>).map((row) => row.id)
}

/**
 * Leader and follower tabs share one worker through the transaction serializer, as in
 * the browser worker entry (sqlite-wasm-worker.ts). Both bugs below lose or partly
 * apply data while every caller is told what happened was fine or retriable.
 */
describe('multi-tab transaction isolation', () => {
	const cleanups: Array<() => void> = []

	beforeEach(() => {
		MockBroadcastChannel.channels.clear()
		vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
	})

	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup()
		vi.unstubAllGlobals()
	})

	test("an error inside a follower's transaction never lets another tab's acknowledged write be rolled back with it", async () => {
		const worker = await openWorker()
		const serializer = new TransactionSerializingWorkerBridge(worker)
		cleanups.push(() => serializer.terminate())
		cleanups.push(startLeaderRpcRelay('kora-storage-isolation', serializer))

		// The leader tab writes straight through the serializer (its own client id).
		const leader = new SqliteWasmAdapter({ bridge: serializer, dbName: 'isolation' })
		await leader.open(minimalSchema)
		const followerBridge = new FollowerBroadcastBridge('kora-storage-isolation', 5000)
		cleanups.push(() => followerBridge.terminate())
		const follower = new SqliteWasmAdapter({ bridge: followerBridge, dbName: 'isolation' })
		await follower.open(minimalSchema)

		let leaderWrite: Promise<void> | undefined
		await expect(
			follower.transaction(async (tx) => {
				await tx.execute(INSERT, ['follower-row', 'rolled back'])
				// The leader's autocommit write queues behind the follower's span...
				leaderWrite = leader.execute(INSERT, ['leader-row', 'acknowledged'])
				// ...and the follower's next statement fails inside the span.
				await tx.execute('INSERT INTO no_such_table VALUES (1)')
			}),
		).rejects.toThrow(/no such table/)

		// The leader was told its write succeeded, so it must still be there.
		await expect(leaderWrite).resolves.toBeUndefined()
		expect(await ids(worker)).toEqual(['leader-row'])
	})

	test('a follower transaction whose leader worker changes mid-span commits nothing on the new worker', async () => {
		const channel = 'kora-storage-handover'
		const oldWorker = await openWorker()
		const oldSerializer = new TransactionSerializingWorkerBridge(oldWorker)
		cleanups.push(() => oldSerializer.terminate())
		const stopOld = startLeaderRpcRelay(channel, oldSerializer)

		const followerBridge = new FollowerBroadcastBridge(channel, 5000)
		cleanups.push(() => followerBridge.terminate())
		const follower = new SqliteWasmAdapter({ bridge: followerBridge, dbName: 'handover' })
		await follower.open(minimalSchema)

		const newWorker = await openWorker()
		const newSerializer = new TransactionSerializingWorkerBridge(newWorker)
		cleanups.push(() => newSerializer.terminate())

		let failure: unknown
		try {
			await follower.transaction(async (tx) => {
				for (let i = 0; i < 20; i += 1) {
					if (i === 5) {
						// Leader handover: the old leader's worker goes away and a new
						// leader's worker answers the same channel. The follower keeps
						// the same bridge object.
						stopOld()
						oldSerializer.terminate()
						cleanups.push(startLeaderRpcRelay(channel, newSerializer))
					}
					await tx.execute(INSERT, [`row-${String(i).padStart(2, '0')}`, 'bulk'])
				}
				await tx.query('SELECT COUNT(*) AS n FROM todos')
			})
		} catch (error) {
			failure = error
		}

		expect(failure).toBeInstanceOf(BridgeTerminatedError)
		expect((failure as BridgeTerminatedError).context).toMatchObject({ retriable: true })
		// Nothing of the transaction committed on the new worker.
		expect(await ids(newWorker)).toEqual([])
		// The new worker serves new transactions normally, so the retry succeeds.
		await follower.transaction(async (tx) => {
			await tx.execute(INSERT, ['retried', 'bulk'])
		})
		expect(await ids(newWorker)).toEqual(['retried'])
	})
})
