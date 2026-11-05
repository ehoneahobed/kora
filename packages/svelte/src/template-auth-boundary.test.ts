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
