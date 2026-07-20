import { QueryStoreCache } from '@korajs/store'
import { describe, expect, it, vi } from 'vitest'
import { resolveQueryStoreCache } from './resolve-query-store-cache'
import type { KoraAppLike } from './types'

describe('resolveQueryStoreCache', () => {
	it('returns the fallback cache when no app is provided', () => {
		const fallback = new QueryStoreCache()
		expect(resolveQueryStoreCache(null, fallback)).toBe(fallback)
		expect(resolveQueryStoreCache(undefined, fallback)).toBe(fallback)
	})

	it('returns the fallback when the app has no getQueryStoreCache method', () => {
		const fallback = new QueryStoreCache()
		const app = { ready: Promise.resolve() } as unknown as KoraAppLike
		expect(resolveQueryStoreCache(app, fallback)).toBe(fallback)
	})

	it("returns the app's own cache when getQueryStoreCache is available", () => {
		const fallback = new QueryStoreCache()
		const appCache = new QueryStoreCache()
		const getQueryStoreCache = vi.fn(() => appCache)
		const app = { ready: Promise.resolve(), getQueryStoreCache } as unknown as KoraAppLike

		expect(resolveQueryStoreCache(app, fallback)).toBe(appCache)
		expect(getQueryStoreCache).toHaveBeenCalled()
	})
})
