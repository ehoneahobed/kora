import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../adapters/sqlite-wasm-channel'
import {
	FollowerBroadcastBridge,
	TransactionSerializingWorkerBridge,
	startLeaderRpcRelay,
} from './tab-storage'

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
		const set = MockBroadcastChannel.channels.get(this.name)
		set?.delete(this)
	}
}

describe('multi-tab tab storage RPC', () => {
	beforeEach(() => {
		MockBroadcastChannel.channels.clear()
		vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
		let id = 0
		vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
			id += 1
			return `00000000-0000-4000-8000-${id.toString().padStart(12, '0')}`
		})
	})

	test('follower forwards worker requests to leader bridge', async () => {
		const channelName = 'kora-storage-test-db'
		const innerBridge = {
			send: vi.fn(
				async (request: WorkerRequest): Promise<WorkerResponse> => ({
					id: request.id,
					type: 'success',
					data: [{ id: 'row-1' }],
				}),
			),
			terminate: vi.fn(),
		}

		const stop = startLeaderRpcRelay(channelName, innerBridge)
		const follower = new FollowerBroadcastBridge(channelName, 5000)

		const response = await follower.send({ id: 7, type: 'query', sql: 'SELECT 1' })

		expect(response.type).toBe('success')
		expect(innerBridge.send).toHaveBeenCalledOnce()

		follower.terminate()
		stop()
	})

	test('waitForLeader resolves true when a leader relay is answering', async () => {
		const channelName = 'kora-storage-ready-db'
		const innerBridge = {
			send: vi.fn(
				async (r: WorkerRequest): Promise<WorkerResponse> => ({ id: r.id, type: 'success' }),
			),
			terminate: vi.fn(),
		}
		const stop = startLeaderRpcRelay(channelName, innerBridge)
		const follower = new FollowerBroadcastBridge(channelName, 5000)

		await expect(follower.waitForLeader(300, 3)).resolves.toBe(true)

		follower.terminate()
		stop()
	})

	test('waitForLeader resolves false when no leader is present', async () => {
		const follower = new FollowerBroadcastBridge('kora-storage-empty-db', 5000)

		await expect(follower.waitForLeader(120, 2)).resolves.toBe(false)

		follower.terminate()
	})

	test('send fails fast with NoLeaderError when the leader is gone', async () => {
		const channelName = 'kora-storage-dead-db'
		const innerBridge = {
			send: vi.fn(
				async (r: WorkerRequest): Promise<WorkerResponse> => ({ id: r.id, type: 'success' }),
			),
			terminate: vi.fn(),
		}
		const stop = startLeaderRpcRelay(channelName, innerBridge)
		// Leader disappears before the follower sends (tab closed / crashed).
		stop()

		// Long hard timeout, short liveness probe: the probe must trip first and reject
		// fast rather than waiting out the 30s ceiling.
		const follower = new FollowerBroadcastBridge(channelName, 30000, 60)

		await expect(follower.send({ id: 1, type: 'query', sql: 'SELECT 1' })).rejects.toMatchObject({
			code: 'NO_LEADER',
		})

		follower.terminate()
	})

	test('serializes whole transaction spans across bridge clients', async () => {
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type)
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const bridge = new TransactionSerializingWorkerBridge(innerBridge)

		await bridge.send({ id: 1, type: 'begin' }, 'leader')
		const followerBegin = bridge.send({ id: 2, type: 'begin' }, 'follower')
		const leaderExecute = bridge.send(
			{ id: 3, type: 'execute', sql: 'INSERT INTO todos VALUES (?)' },
			'leader',
		)

		await leaderExecute
		expect(calls).toEqual(['begin', 'execute'])

		await bridge.send({ id: 4, type: 'commit' }, 'leader')
		await followerBegin

		expect(calls).toEqual(['begin', 'execute', 'commit', 'begin'])
		bridge.terminate()
	})

	test('rolls back and resumes when a transaction client disappears', async () => {
		vi.useFakeTimers()
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type)
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const bridge = new TransactionSerializingWorkerBridge(innerBridge, 50)

		await bridge.send({ id: 1, type: 'begin' }, 'follower')
		const leaderQuery = bridge.send({ id: 2, type: 'query', sql: 'SELECT 1' }, 'leader')

		await vi.advanceTimersByTimeAsync(60)

		await expect(leaderQuery).resolves.toMatchObject({ type: 'success' })
		expect(calls).toEqual(['begin', 'rollback', 'query'])

		await expect(
			bridge.send({ id: 3, type: 'execute', sql: 'INSERT INTO todos VALUES (?)' }, 'follower'),
		).resolves.toMatchObject({
			type: 'error',
			code: 'TRANSACTION_ABORTED',
		})

		await expect(bridge.send({ id: 4, type: 'begin' }, 'follower')).resolves.toMatchObject({
			type: 'success',
		})
		await bridge.send({ id: 5, type: 'rollback' }, 'follower')
		bridge.terminate()
		vi.useRealTimers()
	})
})
