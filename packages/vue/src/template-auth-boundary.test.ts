import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineAsyncComponent, defineComponent, h } from 'vue'
// The scaffolded templates ship these files; they are tested here, where Vue Test Utils is.
import { AuthLoadError } from '../../cli/templates/vue-sync/src/AuthLoadError'
import { useAuthState } from '../../cli/templates/vue-sync/src/auth-state'

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
