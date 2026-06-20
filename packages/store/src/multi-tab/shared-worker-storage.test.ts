import { describe, expect, test } from 'vitest'
import { isSharedWorkerStorageSupported } from './tab-storage'

describe('SharedWorker storage (stretch)', () => {
	test('isSharedWorkerStorageSupported is false in Node test runtime', () => {
		expect(isSharedWorkerStorageSupported()).toBe(false)
	})
})
