import type { Operation } from '@kora/core'
import { describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'

describe('PostgresServerStore', () => {
	test('getNodeId returns provided node ID', async () => {
		const store = new PostgresServerStore(createFakeDb() as never, 'server-pg')
		await Promise.resolve()
		expect(store.getNodeId()).toBe('server-pg')
	})

	test('getVersionVector returns empty map initially', async () => {
		const store = new PostgresServerStore(createFakeDb() as never, 'server-pg')
		await Promise.resolve()
		expect(store.getVersionVector().size).toBe(0)
	})

	test('close prevents further operations', async () => {
		const store = new PostgresServerStore(createFakeDb() as never, 'server-pg')
		await store.close()

		const op: Operation = {
			id: 'op-1',
			nodeId: 'node-a',
			type: 'insert',
			collection: 'todos',
			recordId: 'rec-1',
			data: { title: 'x' },
			previousData: null,
			timestamp: { wallTime: 1, logical: 0, nodeId: 'node-a' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}

		await expect(store.applyRemoteOperation(op)).rejects.toThrow('PostgresServerStore is closed')
	})
})

function createFakeDb(): {
	unsafe: <T = unknown[]>(query: string, params?: unknown[]) => Promise<T>
	end: () => Promise<void>
} {
	return {
		unsafe: async () => [] as unknown as never,
		end: async () => {},
	}
}
