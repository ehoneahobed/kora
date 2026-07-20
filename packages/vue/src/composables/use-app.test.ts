import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraAppLike, KoraContextValue } from '../types'
import { useApp } from './use-app'

function mountUseApp(app: KoraAppLike | null): { captured: KoraAppLike | null; error: unknown } {
	let captured: KoraAppLike | null = null
	let error: unknown = null
	const contextRef = shallowRef<KoraContextValue | null>({
		store: {} as KoraContextValue['store'],
		syncEngine: null,
		app,
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache: {} as KoraContextValue['queryStoreCache'],
	})

	const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		mount(
			defineComponent({
				setup() {
					captured = useApp()
					return () => h('div')
				},
			}),
			{ global: { provide: { [koraContextKey]: contextRef } } },
		)
	} catch (err) {
		error = err
	}
	spy.mockRestore()
	return { captured, error }
}

describe('useApp', () => {
	it('returns the app instance from context', () => {
		const app = { ready: Promise.resolve() } as unknown as KoraAppLike
		const { captured } = mountUseApp(app)
		expect(captured).toBe(app)
	})

	it('throws when the provider was initialized without an app prop', () => {
		const { error } = mountUseApp(null)
		expect((error as Error).message).toContain('useApp() requires <KoraProvider :app="app">')
	})
})
