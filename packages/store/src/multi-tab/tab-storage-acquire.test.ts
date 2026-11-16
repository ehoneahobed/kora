import { afterEach, describe, expect, test, vi } from 'vitest'
import { acquireTabStorageSession } from './tab-storage'

describe('acquireTabStorageSession', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	test('rejects when the leader lock request fails before its callback runs', async () => {
		const failure = new DOMException('The document is not fully active', 'SecurityError')
		vi.stubGlobal('BroadcastChannel', class {})
		vi.stubGlobal('navigator', {
			locks: { request: vi.fn(() => Promise.reject(failure)) },
		})

		await expect(acquireTabStorageSession('kora-acquire-reject-db')).rejects.toBe(failure)
	})
})
