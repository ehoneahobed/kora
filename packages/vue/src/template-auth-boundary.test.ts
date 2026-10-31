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

describe('retryImport (a dropped request for the sign-in client chunk)', () => {
	it('tries again after a failure and returns the module', async () => {
		vi.useFakeTimers()
		const load = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('network'))
			.mockResolvedValueOnce('chunk')
		const loaded = retryImport(load)
		await vi.advanceTimersByTimeAsync(500)
		await expect(loaded).resolves.toBe('chunk')
		expect(load).toHaveBeenCalledTimes(2)
		vi.useRealTimers()
	})

	it('gives up after the last try with the last error', async () => {
		vi.useFakeTimers()
		const load = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('still missing'))
		const loaded = retryImport(load, 3)
		const outcome = expect(loaded).rejects.toThrow('still missing')
		await vi.advanceTimersByTimeAsync(2000)
		await outcome
		expect(load).toHaveBeenCalledTimes(3)
		vi.useRealTimers()
	})
})
