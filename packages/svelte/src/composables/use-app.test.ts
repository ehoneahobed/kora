import { describe, expect, it, vi } from 'vitest'
import type { KoraAppLike } from '../types'
import { getApp, useApp } from './use-app'

const contextValue: { app: KoraAppLike | null } = { app: null }

vi.mock('../context', () => ({
	getKoraContext: () => contextValue,
}))

describe('getApp', () => {
	it('returns the app from context', () => {
		const app = { ready: Promise.resolve() } as unknown as KoraAppLike
		contextValue.app = app
		expect(getApp()).toBe(app)
	})

	it('is aliased as useApp', () => {
		expect(useApp).toBe(getApp)
	})

	it('throws a helpful error when no app is present (store-only provider)', () => {
		contextValue.app = null
		expect(() => getApp()).toThrow('getApp() requires <KoraProvider app={kora}>')
	})
})
