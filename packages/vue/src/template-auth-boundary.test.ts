import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineAsyncComponent, defineComponent, h } from 'vue'
// The scaffolded templates ship these files; they are tested here, where Vue Test Utils is.
import { AuthLoadError } from '../../cli/templates/vue-sync/src/AuthLoadError'
import { useAuthState } from '../../cli/templates/vue-sync/src/auth-state'
import { retryImport } from '../../cli/templates/vue-sync/src/retry-import'

afterEach(() => {
	vi.restoreAllMocks()
})

describe('the template sign-in bridge (a failed sign-in client chunk)', () => {
	it('keeps the rest of the app mounted, reports once, and tells the screen why', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const AuthBridge = defineAsyncComponent({
			loader: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
			errorComponent: AuthLoadError,
		})
		const Root = defineComponent({
			setup: () => () =>
				h('div', [h('span', { 'data-testid': 'list' }, 'task list'), h(AuthBridge)]),
		})
		const wrapper = mount(Root)
		await flushPromises()
		expect(wrapper.get('[data-testid=list]').text()).toBe('task list')
		const state = useAuthState()
		// Still "loading", never mistaken for "signed out", with the reason.
		expect(state.loading).toBe(true)
		expect(state.error).toContain('Sign-in is unavailable')
		expect(
			error.mock.calls.filter((call) => String(call[0]).includes('The sign-in client did not load'))
				.length,
		).toBe(1)
	})
})

describe('retryImport (a failed request for the sign-in client chunk)', () => {
	const page = () => {
		const store = new Map<string, string>()
		return {
			reload: vi.fn(),
			storage: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
			},
			now: () => 1_000_000,
		}
	}

	it('returns the module without touching the page when the load works', async () => {
		const p = page()
		await expect(retryImport(async () => 'chunk', p)).resolves.toBe('chunk')
		expect(p.reload).not.toHaveBeenCalled()
	})

	it('reloads the page once on a failure and stays pending (a browser cannot import the same URL again)', async () => {
		const p = page()
		const settled = vi.fn()
		retryImport(() => Promise.reject(new Error('network')), p).then(settled, settled)
		await vi.waitFor(() => expect(p.reload).toHaveBeenCalledTimes(1))
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(settled).not.toHaveBeenCalled()
	})

	it('after a reload a second failure is thrown, not reloaded again', async () => {
		const p = page()
		p.storage.setItem('kora:chunk-reload:auth', String(p.now() - 1_000))
		await expect(retryImport(() => Promise.reject(new Error('still missing')), p)).rejects.toThrow(
			'still missing',
		)
		expect(p.reload).not.toHaveBeenCalled()
	})

	it('without session storage it throws instead of risking a reload loop', async () => {
		const p = {
			...page(),
			storage: {
				getItem: () => {
					throw new Error('denied')
				},
				setItem: () => {},
			},
		}
		await expect(retryImport(() => Promise.reject(new Error('x')), p)).rejects.toThrow('x')
		expect(p.reload).not.toHaveBeenCalled()
	})
})
