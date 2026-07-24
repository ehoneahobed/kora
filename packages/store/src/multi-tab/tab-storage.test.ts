import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../adapters/sqlite-wasm-channel'
import { FollowerBroadcastBridge, startLeaderRpcRelay } from './tab-storage'

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
		vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
			'00000000-0000-4000-8000-000000000001',
		)
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
})
