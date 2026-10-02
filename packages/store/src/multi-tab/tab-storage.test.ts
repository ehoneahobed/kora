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

	describe('hung-leader detection and request ids (NEW-STORE-9)', () => {
		function slowBridge(): {
			bridge: { send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
			finish: () => void
		} {
			let finish: () => void = () => {}
			const bridge = {
				send: vi.fn(
					(request: WorkerRequest): Promise<WorkerResponse> =>
						new Promise((resolve) => {
							finish = () => resolve({ id: request.id, type: 'success' })
						}),
				),
				terminate: vi.fn(),
			}
			return { bridge, finish: () => finish() }
		}

		test('a leader that keeps sending heartbeats is waited for, however long the request', async () => {
			vi.useFakeTimers()
			const channelName = 'kora-storage-busy-db'
			const { bridge, finish } = slowBridge()
			const stop = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const pending = follower.send({ id: 1, type: 'query', sql: 'SELECT 1' })
			await vi.advanceTimersByTimeAsync(1000)
			finish()
			await expect(pending).resolves.toMatchObject({ type: 'success' })
			follower.terminate()
			stop()
			vi.useRealTimers()
		})

		test('a leader that goes silent fails pending requests with a retriable LeaderUnresponsiveError', async () => {
			vi.useFakeTimers()
			const channelName = 'kora-storage-hung-db'
			const { bridge } = slowBridge()
			const stop = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const pending = follower.send({ id: 1, type: 'execute', sql: 'INSERT', requestId: 'r-1' })
			const settled = pending.catch((error: unknown) => error)
			await vi.advanceTimersByTimeAsync(60)
			// The leader hangs: no heartbeats, no pongs, no response.
			stop()
			await vi.advanceTimersByTimeAsync(100)
			await expect(settled).resolves.toMatchObject({
				name: 'LeaderUnresponsiveError',
				code: 'LEADER_UNRESPONSIVE',
				context: expect.objectContaining({ requestId: 'r-1', retriable: true }),
			})
			follower.terminate()
			vi.useRealTimers()
		})

		test('the leader answers a retried request id from its cache instead of applying it twice', async () => {
			const channelName = 'kora-storage-dedup-db'
			const bridge = {
				send: vi.fn(
					async (r: WorkerRequest): Promise<WorkerResponse> => ({ id: r.id, type: 'success' }),
				),
				terminate: vi.fn(),
			}
			const stop = startLeaderRpcRelay(channelName, bridge)
			const follower = new FollowerBroadcastBridge(channelName, 5000)
			const request: WorkerRequest = { id: 1, type: 'execute', sql: 'INSERT', requestId: 'same' }
			await follower.send(request)
			await follower.send(request)
			expect(bridge.send).toHaveBeenCalledOnce()
			follower.terminate()
			stop()
		})

		test('an AbortSignal cancels the wait with RequestAbortedError', async () => {
			const channelName = 'kora-storage-abort-db'
			const { bridge } = slowBridge()
			const stop = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const controller = new AbortController()
			const pending = follower.send({ id: 1, type: 'query', sql: 'SELECT 1' }, undefined, {
				signal: controller.signal,
			})
			controller.abort()
			await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
			follower.terminate()
			stop()
		})

		test('terminating a follower bridge rejects pending requests with a retriable error', async () => {
			const channelName = 'kora-storage-terminate-db'
			const { bridge } = slowBridge()
			const stop = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const pending = follower.send({ id: 1, type: 'query', sql: 'SELECT 1' })
			follower.terminate()
			await expect(pending).rejects.toMatchObject({
				code: 'BRIDGE_TERMINATED',
				context: expect.objectContaining({ retriable: true }),
			})
			stop()
		})

		test('a follower cannot close or destroy the leader database', async () => {
			const channelName = 'kora-storage-close-db'
			const bridge = {
				send: vi.fn(
					async (r: WorkerRequest): Promise<WorkerResponse> => ({ id: r.id, type: 'success' }),
				),
				terminate: vi.fn(),
			}
			const stop = startLeaderRpcRelay(channelName, bridge)
			const follower = new FollowerBroadcastBridge(channelName, 5000)
			await expect(follower.send({ id: 1, type: 'close' })).resolves.toMatchObject({
				type: 'success',
			})
			await expect(follower.send({ id: 2, type: 'destroy' })).resolves.toMatchObject({
				type: 'success',
			})
			expect(bridge.send).not.toHaveBeenCalled()
			follower.terminate()
			stop()
		})
	})
})
