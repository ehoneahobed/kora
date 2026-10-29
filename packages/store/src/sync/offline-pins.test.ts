import { OFFLINE_PIN_LIMIT } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import {
	addOfflinePinHold,
	ensureOfflinePin,
	ensureOfflinePinTables,
	keepOfflinePin,
	loadOfflinePinHolds,
	loadOfflinePins,
	markOfflinePinCompleted,
	pruneOfflinePinHolds,
	releaseOfflinePin,
	removeOfflinePinHold,
} from './offline-pins'

async function openAdapter(): Promise<BetterSqlite3Adapter> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	await adapter.open(minimalSchema)
	await ensureOfflinePinTables(adapter)
	return adapter
}

const pin = (id: string, where: Record<string, unknown> = {}, files = false) => ({
	id,
	collection: 'notes',
	where,
	files,
})
const holdOf = (holder: string, tabId: string) => ({ holder, tabId, tabLock: `lock:${tabId}` })

describe('pin storage', () => {
	test('keep creates an explicit pin, once', async () => {
		const adapter = await openAdapter()
		expect(await keepOfflinePin(adapter, pin('p1', { a: 1 }, true), 100)).toEqual({
			created: true,
			deleted: false,
		})
		expect((await keepOfflinePin(adapter, pin('p1', { a: 1 }, true), 200)).created).toBe(false)
		expect(await loadOfflinePins(adapter)).toEqual([
			{
				id: 'p1',
				collection: 'notes',
				where: { a: 1 },
				files: true,
				explicit: true,
				createdAt: 100,
				completedAt: null,
			},
		])
	})

	test('the 65th pin is refused with OFFLINE_PIN_LIMIT and changes nothing', async () => {
		const adapter = await openAdapter()
		for (let i = 0; i < OFFLINE_PIN_LIMIT; i++) await keepOfflinePin(adapter, pin(`p${i}`), i)
		await expect(keepOfflinePin(adapter, pin('extra'), 0)).rejects.toMatchObject({
			code: 'OFFLINE_PIN_LIMIT',
		})
		await expect(
			addOfflinePinHold(adapter, pin('extra'), holdOf('h', 'tab'), 0),
		).rejects.toMatchObject({ code: 'OFFLINE_PIN_LIMIT' })
		expect(await loadOfflinePins(adapter)).toHaveLength(OFFLINE_PIN_LIMIT)
		expect(await loadOfflinePinHolds(adapter)).toEqual([])
		// An existing pin can still be held or kept again at the limit.
		await addOfflinePinHold(adapter, pin('p0'), holdOf('h', 'tab'), 0)
		expect(await loadOfflinePinHolds(adapter)).toHaveLength(1)
	})

	test('a pin goes with its last holder unless it is explicit', async () => {
		const adapter = await openAdapter()
		await addOfflinePinHold(adapter, pin('p1'), holdOf('a:1', 'a'), 0)
		await addOfflinePinHold(adapter, pin('p1'), holdOf('b:1', 'b'), 0)
		expect((await removeOfflinePinHold(adapter, 'p1', 'a:1')).deleted).toBe(false)
		expect((await removeOfflinePinHold(adapter, 'p1', 'b:1')).deleted).toBe(true)
		expect(await loadOfflinePins(adapter)).toEqual([])

		await keepOfflinePin(adapter, pin('p2'), 0)
		await addOfflinePinHold(adapter, pin('p2'), holdOf('a:2', 'a'), 0)
		expect((await removeOfflinePinHold(adapter, 'p2', 'a:2')).deleted).toBe(false)
		expect((await releaseOfflinePin(adapter, 'p2')).deleted).toBe(true)
	})

	test('releasing an explicit pin that a component still holds keeps the pin', async () => {
		const adapter = await openAdapter()
		await keepOfflinePin(adapter, pin('p1'), 0)
		await addOfflinePinHold(adapter, pin('p1'), holdOf('a:1', 'a'), 0)
		expect((await releaseOfflinePin(adapter, 'p1')).deleted).toBe(false)
		expect((await loadOfflinePins(adapter))[0]?.explicit).toBe(false)
	})

	test('one holder id is one hold', async () => {
		const adapter = await openAdapter()
		await addOfflinePinHold(adapter, pin('p1'), holdOf('a:1', 'a'), 0)
		await addOfflinePinHold(adapter, pin('p1'), holdOf('a:1', 'a'), 0)
		expect(await loadOfflinePinHolds(adapter)).toHaveLength(1)
	})

	test('pruning deletes the holds of stale tabs and the pins only they kept, in one step', async () => {
		const adapter = await openAdapter()
		await addOfflinePinHold(adapter, pin('only-a'), holdOf('a:1', 'a'), 0)
		await addOfflinePinHold(adapter, pin('shared'), holdOf('a:2', 'a'), 0)
		await addOfflinePinHold(adapter, pin('shared'), holdOf('b:1', 'b'), 0)
		await keepOfflinePin(adapter, pin('explicit'), 0)
		await addOfflinePinHold(adapter, pin('explicit'), holdOf('a:3', 'a'), 0)

		const asked: string[] = []
		const result = await pruneOfflinePinHolds(adapter, (tabId) => {
			asked.push(tabId)
			return tabId === 'a'
		})
		expect(result).toEqual({ holdsRemoved: 3, pinsRemoved: 1 })
		expect(asked.sort()).toEqual(['a', 'b'])
		expect((await loadOfflinePins(adapter)).map((p) => p.id).sort()).toEqual(['explicit', 'shared'])
		expect((await loadOfflinePinHolds(adapter)).map((h) => h.holder)).toEqual(['b:1'])
	})

	test('completion is recorded for display only', async () => {
		const adapter = await openAdapter()
		await keepOfflinePin(adapter, pin('p1'), 0)
		await markOfflinePinCompleted(adapter, 'p1', 55)
		expect((await loadOfflinePins(adapter))[0]?.completedAt).toBe(55)
	})

	test('an unreadable filter keeps the pin and matches the whole collection', async () => {
		const adapter = await openAdapter()
		await keepOfflinePin(adapter, pin('p1', { a: 1 }), 0)
		await adapter.execute("UPDATE _kora_offline_pins SET where_json = '{nope'")
		expect((await loadOfflinePins(adapter))[0]?.where).toEqual({})
	})
})

describe('Store', () => {
	test('creates the pin tables on open and writes through its gate, durably', async () => {
		const store = new Store({
			schema: minimalSchema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'n1',
		})
		await store.open()
		expect(await store.loadOfflinePins()).toEqual([])
		await store.keepOfflinePin(pin('p1'))
		await store.addOfflinePinHold(pin('p2'), holdOf('h', 't'))
		expect((await store.loadOfflinePins()).map((p) => p.id)).toEqual(['p1', 'p2'])
		expect(await store.loadOfflinePinHolds()).toHaveLength(1)
		expect(await store.pruneOfflinePinHolds((tab) => tab === 't')).toEqual({
			holdsRemoved: 1,
			pinsRemoved: 1,
		})
		await store.releaseOfflinePin('p1')
		expect(await store.loadOfflinePins()).toEqual([])
		await store.close()
	})
})

describe('pins held outside the table (explicit mode)', () => {
	test('ensure creates a pin without marking it kept, and leaves a kept pin kept', async () => {
		const adapter = await openAdapter()
		await ensureOfflinePin(adapter, pin('p1'), 1)
		expect((await loadOfflinePins(adapter))[0]?.explicit).toBe(false)
		await keepOfflinePin(adapter, pin('p2'), 2)
		await ensureOfflinePin(adapter, pin('p2'), 3)
		expect((await loadOfflinePins(adapter)).find((p) => p.id === 'p2')?.explicit).toBe(true)
	})

	test('release with stillHeld clears the flag but keeps the pin', async () => {
		const adapter = await openAdapter()
		await keepOfflinePin(adapter, pin('p1'), 1)
		const result = await releaseOfflinePin(adapter, 'p1', { stillHeld: true })
		expect(result.deleted).toBe(false)
		expect(await loadOfflinePins(adapter)).toEqual([
			expect.objectContaining({ id: 'p1', explicit: false }),
		])
		expect((await removeOfflinePinHold(adapter, 'p1', 'nobody')).deleted).toBe(true)
	})
})
