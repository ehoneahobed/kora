import { defineSchema, t } from '@korajs/core'
import { Store } from '@korajs/store'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SqliteWasmAdapter } from '../../src/adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import { FollowerBroadcastBridge, startLeaderRpcRelay } from '../../src/multi-tab/tab-storage'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

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

/**
 * Leader + follower tabs sharing one SQLite database via BroadcastChannel RPC.
 */
describe('multi-tab storage E2E', () => {
	const channelName = 'kora-storage-integration-e2e'
	let stopRelay: (() => void) | null = null
	let leaderStore: Store | null = null
	let followerStore: Store | null = null

	beforeEach(() => {
		MockBroadcastChannel.channels.clear()
		vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
		let rpcId = 0
		vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
			() => `00000000-0000-4000-8000-${String(++rpcId).padStart(12, '0')}`,
		)
	})

	afterEach(async () => {
		await followerStore?.close()
		await leaderStore?.close()
		followerStore = null
		leaderStore = null
		stopRelay?.()
		stopRelay = null
		vi.unstubAllGlobals()
	})

	test('follower writes are visible to leader tab', async () => {
		const innerBridge = new MockWorkerBridge()
		stopRelay = startLeaderRpcRelay(channelName, innerBridge)

		const leaderAdapter = new SqliteWasmAdapter({
			bridge: innerBridge,
			dbName: 'multi-tab-e2e',
		})
		const followerAdapter = new SqliteWasmAdapter({
			bridge: new FollowerBroadcastBridge(channelName),
			dbName: 'multi-tab-e2e',
		})

		leaderStore = new Store({
			schema,
			adapter: leaderAdapter,
			nodeId: 'leader-node',
		})
		followerStore = new Store({
			schema,
			adapter: followerAdapter,
			nodeId: 'follower-node',
		})

		await leaderStore.open()
		await followerStore.open()

		await followerStore.collection('todos').insert({ title: 'From follower tab' })

		const leaderTodos = await leaderStore.collection('todos').where({}).exec()
		expect(leaderTodos).toHaveLength(1)
		expect(leaderTodos[0]?.title).toBe('From follower tab')

		const followerTodos = await followerStore.collection('todos').where({}).exec()
		expect(followerTodos).toHaveLength(1)
	})
})
