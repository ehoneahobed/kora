import { SyncError, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import type { HeldNodeInfo } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { createApp } from './create-app'
import type { KoraConfig } from './types'
import { type UnassignedWritesEngine, wireUnassignedWritesPolicy } from './unassigned-writes'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

const config = (unassignedWrites?: 'hold' | 'assign-to-first-user'): KoraConfig => ({
	schema,
	sync: { url: 'ws://test', ...(unassignedWrites ? { unassignedWrites } : {}) },
})

function fakeEngine(held: HeldNodeInfo[], refuse: string[] = []) {
	const calls = { assigned: [] as string[], reconnects: 0 }
	const engine: UnassignedWritesEngine = {
		getHeldNodes: async () => held,
		assignHeld: async (nodeId) => {
			if (refuse.includes(nodeId)) {
				throw new SyncError('no', { code: 'HELD_NODE_NOT_ASSIGNABLE', nodeId })
			}
			calls.assigned.push(nodeId)
		},
		reconnect: async () => {
			calls.reconnects++
		},
	}
	return { engine, calls }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('wireUnassignedWritesPolicy', () => {
	const held: HeldNodeInfo[] = [
		{ nodeId: 'n-unassigned', operationCount: 2, reason: 'unassigned', principal: null },
		{ nodeId: 'n-other', operationCount: 1, reason: 'other-user', principal: 'alice' },
		{ nodeId: 'n-raced', operationCount: 1, reason: 'unassigned', principal: null },
	]

	test("'assign-to-first-user' assigns only unassigned writes on an accepted session, then reconnects", async () => {
		const emitter = new SimpleEventEmitter()
		const { engine, calls } = fakeEngine(held, ['n-raced'])
		wireUnassignedWritesPolicy(
			config('assign-to-first-user'),
			emitter,
			() => engine,
			() => false,
		)
		expect(calls.assigned).toEqual([])
		emitter.emit({ type: 'sync:connected', nodeId: 'session' })
		await settle()
		expect(calls).toEqual({ assigned: ['n-unassigned'], reconnects: 1 })
	})

	test("'hold' (the default) never assigns", async () => {
		for (const policy of ['hold', undefined] as const) {
			const emitter = new SimpleEventEmitter()
			const { engine, calls } = fakeEngine(held)
			wireUnassignedWritesPolicy(
				config(policy),
				emitter,
				() => engine,
				() => false,
			)
			emitter.emit({ type: 'sync:connected', nodeId: 'session' })
			await settle()
			expect(calls).toEqual({ assigned: [], reconnects: 0 })
		}
	})

	test('no reconnect while sync is intentionally offline or nothing was assigned', async () => {
		const emitter = new SimpleEventEmitter()
		const { engine, calls } = fakeEngine(held)
		wireUnassignedWritesPolicy(
			config('assign-to-first-user'),
			emitter,
			() => engine,
			() => true,
		)
		emitter.emit({ type: 'sync:connected', nodeId: 'session' })
		await settle()
		expect(calls.reconnects).toBe(0)
		const none = fakeEngine([held[1] as HeldNodeInfo])
		const emitter2 = new SimpleEventEmitter()
		wireUnassignedWritesPolicy(
			config('assign-to-first-user'),
			emitter2,
			() => none.engine,
			() => false,
		)
		emitter2.emit({ type: 'sync:connected', nodeId: 'session' })
		await settle()
		expect(none.calls).toEqual({ assigned: [], reconnects: 0 })
	})

	test('createApp rejects an unknown policy', () => {
		expect(() =>
			createApp({
				schema,
				store: { adapter: 'better-sqlite3', name: ':memory:' },
				sync: { url: 'ws://test', unassignedWrites: 'everyone' as never },
			}),
		).toThrow(/unassignedWrites/)
	})
})
