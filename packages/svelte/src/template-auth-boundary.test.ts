import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
// The scaffolded templates ship these files; they are tested here, where Svelte is.
import { auth } from '../../cli/templates/svelte-sync/src/auth-state'
import { loadAuthBridge } from '../../cli/templates/svelte-sync/src/load-auth-bridge'
import { retryImport } from '../../cli/templates/svelte-sync/src/retry-import'

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
