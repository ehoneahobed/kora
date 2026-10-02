import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import type { StorageAdapter, Transaction } from '../types'
import {
	loadAcceptedDownlinkScope,
	loadOwnAckedThrough,
	loadUnappliedOperations,
	removeUnappliedOperations,
	saveAcceptedDownlinkScope,
	saveOwnAckedThrough,
	saveUnappliedOperations,
} from './sync-durability'
import { loadDeliveryWatermark } from './sync-state'

function op(id: string): Operation {
	return {
		id,
		nodeId: 'peer',
		type: 'insert',
		collection: 'notes',
		recordId: `r-${id}`,
		data: { body: id },
		previousData: null,
		timestamp: { wallTime: 1_000, logical: 0, nodeId: 'peer' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 2,
	}
}

async function openAdapter(): Promise<BetterSqlite3Adapter> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	await adapter.open(minimalSchema)
	return adapter
}

describe('inbound quarantine (_kora_unapplied_ops)', () => {
	test('round-trips operations and advances the watermark in the same write', async () => {
		const adapter = await openAdapter()
		await saveUnappliedOperations(
			adapter,
			[
				{
					operation: op('a'),
					deliverySequence: 4,
					code: 'APPLY_SKIPPED',
					message: 'unknown collection',
					quarantinedAt: 7,
				},
			],
			{ signature: '', watermark: 4 },
		)
		const loaded = await loadUnappliedOperations(adapter)
		expect(loaded).toEqual([
			{
				operation: op('a'),
				deliverySequence: 4,
				code: 'APPLY_SKIPPED',
				message: 'unknown collection',
				quarantinedAt: 7,
			},
		])
		expect(await loadDeliveryWatermark(adapter, '')).toBe(4)
		await removeUnappliedOperations(adapter, ['a'])
		expect(await loadUnappliedOperations(adapter)).toEqual([])
		await adapter.close()
	})

	test('a failed write records neither the rows nor the watermark (atomic)', async () => {
		const real = await openAdapter()
		// Fail the watermark statement inside the transaction.
		const failing: StorageAdapter = {
			...real,
			open: real.open.bind(real),
			close: real.close.bind(real),
			execute: real.execute.bind(real),
			query: real.query.bind(real),
			migrate: real.migrate.bind(real),
			transaction: (fn) =>
				real.transaction(async (tx: Transaction) =>
					fn({
						execute: async (sql, params) => {
							if (sql.includes('_kora_meta')) throw new Error('disk full')
							await tx.execute(sql, params)
						},
						query: (sql, params) => tx.query(sql, params),
					}),
				),
		}
		await expect(
			saveUnappliedOperations(
				failing,
				[{ operation: op('b'), deliverySequence: 9, code: 'X', message: 'x', quarantinedAt: 0 }],
				{ signature: '', watermark: 9 },
			),
		).rejects.toThrow('disk full')
		expect(await loadUnappliedOperations(real)).toEqual([])
		expect(await loadDeliveryWatermark(real, '')).toBe(0)
		await real.close()
	})
})

describe('own acknowledged prefix and accepted scope', () => {
	test('the prefix is keyed by node id; an unknown node or a fresh database reads null', async () => {
		const adapter = await openAdapter()
		expect(await loadOwnAckedThrough(adapter, 'n1')).toBeNull()
		await saveOwnAckedThrough(adapter, 'n1', 12)
		expect(await loadOwnAckedThrough(adapter, 'n1')).toBe(12)
		expect(await loadOwnAckedThrough(adapter, 'n2')).toBeNull()
		await adapter.close()
	})

	test('the accepted downlink scope round-trips and clears', async () => {
		const adapter = await openAdapter()
		expect(await loadAcceptedDownlinkScope(adapter)).toBeNull()
		await saveAcceptedDownlinkScope(adapter, { todos: { orgId: 'o1' } })
		expect(await loadAcceptedDownlinkScope(adapter)).toEqual({ todos: { orgId: 'o1' } })
		await saveAcceptedDownlinkScope(adapter, null)
		expect(await loadAcceptedDownlinkScope(adapter)).toBeNull()
		await adapter.close()
	})
})
