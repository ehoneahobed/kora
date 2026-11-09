import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hasCompletedReplica, watchCompletedReplica } from './replica-marker'

function fakeStorage(): Storage {
	const values = new Map<string, string>()
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
		clear: () => values.clear(),
		key: () => null,
		get length() {
			return values.size
		},
	}
}

function database(epoch: string): void {
	localStorage.setItem('kora:db:app', JSON.stringify({ v: 1, epoch, backend: 'opfs' }))
}

async function settled(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('completed replica marker', () => {
	beforeEach(() => vi.stubGlobal('localStorage', fakeStorage()))
	afterEach(() => vi.unstubAllGlobals())

	test('a database with no completion is not a completed replica', () => {
		database('e1')
		expect(hasCompletedReplica('app')).toBe(false)
	})

	test('a device that completed earlier is recorded at the first open', async () => {
		database('e1')
		watchCompletedReplica({ dbName: 'app', loadMarks: async () => ({ marks: [{}] }) })
		await settled()
		expect(hasCompletedReplica('app')).toBe(true)
	})

	test('a first download is recorded when the view completes, not before', async () => {
		database('e1')
		let marks: unknown[] = []
		let listener: (status: { activeViewComplete?: boolean }) => void = () => {}
		const unsubscribe = vi.fn()
		watchCompletedReplica({
			dbName: 'app',
			loadMarks: async () => ({ marks }),
			subscribeStatus: (next) => {
				listener = next
				return unsubscribe
			},
		})
		await settled()
		listener({ activeViewComplete: false })
		await settled()
		expect(hasCompletedReplica('app')).toBe(false)

		marks = [{}]
		listener({ activeViewComplete: true })
		await settled()
		expect(hasCompletedReplica('app')).toBe(true)
		expect(unsubscribe).toHaveBeenCalledOnce()
	})

	test('a database replaced after an eviction is not a completed replica', async () => {
		database('e1')
		watchCompletedReplica({ dbName: 'app', loadMarks: async () => ({ marks: [{}] }) })
		await settled()
		database('e2')
		expect(hasCompletedReplica('app')).toBe(false)
	})

	test('a deleted database is not a completed replica', async () => {
		database('e1')
		watchCompletedReplica({ dbName: 'app', loadMarks: async () => ({ marks: [{}] }) })
		await settled()
		localStorage.removeItem('kora:db:app')
		expect(hasCompletedReplica('app')).toBe(false)
	})

	test('without evidence of the database nothing is recorded', async () => {
		watchCompletedReplica({ dbName: 'app', loadMarks: async () => ({ marks: [{}] }) })
		await settled()
		expect(hasCompletedReplica('app')).toBe(false)
	})

	test('a failed read of the marks records nothing and does not throw', async () => {
		database('e1')
		watchCompletedReplica({
			dbName: 'app',
			loadMarks: async () => {
				throw new Error('closed')
			},
		})
		await settled()
		expect(hasCompletedReplica('app')).toBe(false)
	})

	test('blocked site data reads as unknown', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('blocked')
			},
		})
		expect(hasCompletedReplica('app')).toBe(false)
	})
})
