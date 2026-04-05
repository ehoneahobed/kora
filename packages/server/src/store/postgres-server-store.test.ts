import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'

/**
 * Creates a fake Drizzle PostgresJsDatabase-like object for unit tests.
 * Implements just enough of the Drizzle API surface to exercise the store's
 * initialization path and error handling.
 */
function createFakeDrizzleDb(): unknown {
	// Chainable builder that returns empty results
	const chainable = (): Record<string, unknown> => {
		const builder: Record<string, unknown> = {}
		const methods = [
			'select',
			'from',
			'where',
			'orderBy',
			'limit',
			'insert',
			'values',
			'onConflictDoNothing',
			'onConflictDoUpdate',
		]
		for (const method of methods) {
			builder[method] = (..._args: unknown[]) => builder
		}
		// Terminal: resolves to empty array
		builder.then = (resolve: (value: unknown[]) => void) => {
			resolve([])
			return Promise.resolve([])
		}
		return builder
	}

	return {
		select: (..._args: unknown[]) => chainable(),
		insert: (..._args: unknown[]) => chainable(),
		execute: async () => [],
		transaction: async (fn: (tx: unknown) => Promise<void>) => {
			const tx = {
				select: (..._args: unknown[]) => chainable(),
				insert: (..._args: unknown[]) => chainable(),
				execute: async () => [],
			}
			await fn(tx)
		},
	}
}

describe('PostgresServerStore', () => {
	test('getNodeId returns provided node ID', async () => {
		const store = new PostgresServerStore(createFakeDrizzleDb() as never, 'server-pg')
		await Promise.resolve()
		expect(store.getNodeId()).toBe('server-pg')
	})

	test('getVersionVector returns empty map initially', async () => {
		const store = new PostgresServerStore(createFakeDrizzleDb() as never, 'server-pg')
		await Promise.resolve()
		expect(store.getVersionVector().size).toBe(0)
	})

	test('close prevents further operations', async () => {
		const store = new PostgresServerStore(createFakeDrizzleDb() as never, 'server-pg')
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
