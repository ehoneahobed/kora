/**
 * A scoped session reads the delivery visibility index (C2.4) and receives exactly what
 * the global scan would send it: same operations, same order, same retractions. The index
 * is exercised across several scan chunks, records that move between tenants, and the
 * fallbacks (unrestricted sessions, a scope field outside the partition plan).
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { DeliveryIndexRead } from '../../src/store/delivery-partitions'
import { createHarness } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { schoolId: t.string(), body: t.string().default('') }, scope: ['schoolId'] },
		topics: { fields: { name: t.string(), colour: t.string().default('') } },
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => {
		if (token === 'north') {
			return { userId: 'north', scopes: { notes: { schoolId: 'north' }, topics: {} } }
		}
		if (token === 'ember') {
			// colour is not a partition field: the collection is read whole (a miss).
			return {
				userId: 'ember',
				scopes: { notes: { schoolId: 'north' }, topics: { colour: 'red' } },
			}
		}
		return null
	},
})

function stream(messages: SyncMessage[]): string[] {
	const out: string[] = []
	for (const m of messages) {
		if (m.type !== 'operation-batch') continue
		for (const op of m.operations as Array<{ id: string }>) out.push(op.id)
	}
	return out
}

async function seed(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
	const ctx = harness.server.getKoraContext()
	const schools = ['north', 'south', 'east']
	for (let i = 0; i < 120; i++) {
		await ctx.apply({
			collection: 'notes',
			type: 'insert',
			recordId: `n${i}`,
			data: { schoolId: schools[i % 3], body: `b${i}` },
		})
		if (i % 7 === 0) {
			await ctx.apply({
				collection: 'notes',
				type: 'update',
				recordId: `n${i}`,
				data: { schoolId: schools[(i + 1) % 3] },
			})
		}
		if (i % 5 === 0) {
			await ctx.apply({
				collection: 'topics',
				type: 'insert',
				recordId: `t${i}`,
				data: { name: `t${i}`, colour: i % 10 === 0 ? 'red' : 'blue' },
			})
		}
	}
	await harness.store.whenDeliveryIndexIdle?.()
}

async function deliveredBothWays(
	token: string,
	logs: Array<{ event?: string; details?: unknown }> = [],
): Promise<{ indexed: string[]; scanned: string[]; indexReads: number }> {
	const harness = await createHarness(schema, auth, {
		batchSize: 10,
		logger: { log: (entry) => logs.push(entry) },
	})
	await seed(harness)
	const store = harness.store as unknown as {
		getOperationsAfterDeliveryIn?: (...args: unknown[]) => Promise<DeliveryIndexRead>
	}
	const original = store.getOperationsAfterDeliveryIn
	let indexReads = 0
	if (original) {
		store.getOperationsAfterDeliveryIn = (...args) => {
			indexReads += 1
			return original.apply(harness.store, args)
		}
	}
	const withIndex = await harness.login(token, `${token}-1`, { lastDeliverySequence: 0 } as never)
	// A second session of the same server meets the same partition miss.
	await harness.login(token, `${token}-3`, { lastDeliverySequence: 0 } as never)
	store.getOperationsAfterDeliveryIn = undefined
	const without = await harness.login(token, `${token}-2`, { lastDeliverySequence: 0 } as never)
	return { indexed: stream(withIndex.messages), scanned: stream(without.messages), indexReads }
}

describe('scoped delivery through the index', () => {
	test('sends what the global scan sends, in the same order', async () => {
		const { indexed, scanned, indexReads } = await deliveredBothWays('north')
		expect(scanned.length).toBeGreaterThan(20)
		expect(indexed).toEqual(scanned)
		expect(indexReads).toBeGreaterThan(0)
	})

	test('a scope field outside the partition plan reads the collection whole and says so', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			const logs: Array<{ event?: string; details?: unknown }> = []
			const { indexed, scanned } = await deliveredBothWays('ember', logs)
			expect(indexed).toEqual(scanned)
			// Reported once per collection and field, however many sessions meet it.
			expect(logs.filter((entry) => entry.event === 'delivery.partition_miss')).toEqual([
				expect.objectContaining({ details: { collection: 'topics', field: 'colour' } }),
			])
		} finally {
			warn.mockRestore()
		}
	})
})
