import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	PREWARMED_WORKERS_KEY,
	discardPrewarmedWorker,
	takePrewarmedWorker,
} from './prewarmed-worker'

const g = globalThis as unknown as Record<symbol, Map<string, Worker> | undefined>

function fakeWorker(): Worker {
	return { terminate: vi.fn() } as unknown as Worker
}

afterEach(() => {
	delete g[PREWARMED_WORKERS_KEY]
})

describe('prewarmed SQLite worker registry', () => {
	test('a waiting worker is taken once, by its URL', () => {
		const worker = fakeWorker()
		g[PREWARMED_WORKERS_KEY] = new Map([['https://app.test/kora-worker.js', worker]])
		expect(takePrewarmedWorker('https://app.test/other.js')).toBeNull()
		expect(takePrewarmedWorker('https://app.test/kora-worker.js')).toBe(worker)
		expect(takePrewarmedWorker('https://app.test/kora-worker.js')).toBeNull()
	})

	test('no registry: nothing to take or discard', () => {
		expect(takePrewarmedWorker('https://app.test/kora-worker.js')).toBeNull()
		expect(() => discardPrewarmedWorker('https://app.test/kora-worker.js')).not.toThrow()
	})

	test('a discarded worker is stopped and leaves the registry', () => {
		const worker = fakeWorker()
		g[PREWARMED_WORKERS_KEY] = new Map([['https://app.test/kora-worker.js', worker]])
		discardPrewarmedWorker(new URL('https://app.test/kora-worker.js'))
		expect(worker.terminate).toHaveBeenCalledOnce()
		expect(g[PREWARMED_WORKERS_KEY]?.size).toBe(0)
	})
})
