import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
// The scaffolded templates ship these files; they are tested here, where Svelte is.
import { auth } from '../../cli/templates/svelte-sync/src/auth-state'
import { loadAuthBridge } from '../../cli/templates/svelte-sync/src/load-auth-bridge'

afterEach(() => {
	vi.restoreAllMocks()
})

describe('the template sign-in bridge loader (a failed sign-in client chunk)', () => {
	it('tells the screen why, stays "loading", reports once, and still rejects for the await block', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const bridge = loadAuthBridge(() =>
			Promise.reject(new Error('Failed to fetch dynamically imported module')),
		)
		await expect(bridge).rejects.toThrow('Failed to fetch')
		const state = get(auth)
		expect(state.isLoading).toBe(true)
		expect(state.isAuthenticated).toBe(false)
		expect(state.error).toContain('Sign-in is unavailable')
		expect(
			error.mock.calls.filter((call) => String(call[0]).includes('The sign-in client did not load'))
				.length,
		).toBe(1)
	})

	it('hands back the component when the load succeeds, without touching the screen state', async () => {
		const before = get(auth)
		const component = { default: 'bridge' }
		await expect(loadAuthBridge(() => Promise.resolve(component))).resolves.toBe(component)
		expect(get(auth)).toEqual(before)
	})
})
