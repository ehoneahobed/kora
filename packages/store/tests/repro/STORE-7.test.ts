import { describe, expect, test } from 'vitest'
import { IndexedDbPersistenceScheduler } from '../../src/adapters/indexeddb-persistence-scheduler'

// STORE-7: a flushNow() (close(), tab hidden) issued while a snapshot write is
// in flight must still persist writes that happened after that snapshot began.
describe('STORE-7 persistence scheduler re-entrancy', () => {
	test('flushNow during an in-flight flush persists the latest state', async () => {
		let live = 0 // in-memory DB "version"
		let persisted = -1
		let release!: () => void
		let first = true
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 60_000,
			flush: async () => {
				const snapshot = live // dump is taken at flush start
				if (first) {
					first = false
					await new Promise<void>((r) => {
						release = r
					})
				}
				persisted = snapshot
			},
		})

		live = 1
		const f1 = scheduler.flushNow() // snapshot of v1 in flight
		await Promise.resolve()
		live = 2 // a new committed mutation...
		scheduler.schedule() // ...schedules a debounced flush
		const f2 = scheduler.flushNow() // e.g. adapter.close() / visibilitychange
		release()
		await Promise.all([f1, f2])
		scheduler.dispose() // close() disposes right after flushNow()
		expect(persisted).toBe(2)
	})
})
