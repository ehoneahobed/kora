import type { Page } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { OfflineAssertionError } from './errors'
import { PROBE_STORAGE_KEY, assertReadyMeansOffline, expectNeverReady } from './readiness'
import type { OfflineStatusLike } from './types'

const status = (state: OfflineStatusLike['state'], reasons: string[] = []): OfflineStatusLike => ({
	state,
	reasons,
})

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * A fake page for `expectNeverReady`: status reads answer from a script, and the probe's
 * sessionStorage record is whatever `probe` holds.
 */
function probedPage(script: OfflineStatusLike[], probe: unknown = null) {
	let reads = 0
	let stored: unknown = probe
	const page = {
		initScripts: 0,
		async addInitScript() {
			this.initScripts += 1
		},
		async evaluate(_fn: unknown, arg: unknown): Promise<unknown> {
			if (typeof arg === 'object' && arg !== null && 'storageKey' in arg) return undefined
			if (typeof arg === 'object' && arg !== null && 'accessor' in arg) {
				const s = script[Math.min(reads, script.length - 1)]
				reads += 1
				return s ?? null
			}
			if (arg === PROBE_STORAGE_KEY) {
				// Both the "clear" and the "read back" evaluations pass the key.
				const out = stored === null ? null : JSON.stringify(stored)
				stored = stored === null ? null : stored
				return out
			}
			return undefined
		},
	}
	return page as unknown as Page & { initScripts: number }
}

describe('expectNeverReady', () => {
	it('reports no ready when the scenario never reaches it', async () => {
		const page = probedPage([
			status('preparing', ['shell-installing']),
			status('not-ready', ['shell-none']),
		])
		const report = await expectNeverReady(
			page,
			async () => {
				await yieldToEventLoop()
				await yieldToEventLoop()
			},
			{ sleep: yieldToEventLoop },
		)
		expect(report.everReady).toBe(false)
		expect(report.statesSeen).toEqual(['not-ready', 'preparing'])
		expect(report.reasonsSeen).toEqual(['shell-installing', 'shell-none'])
		expect(report.probeRead).toBe(false)
		expect(page.initScripts).toBe(1)
		expect(() => report.assertNeverReady()).not.toThrow()
	})

	it('flags a ready seen by the Node-side sampler', async () => {
		const page = probedPage([status('preparing'), status('ready')])
		const report = await expectNeverReady(
			page,
			async () => {
				for (let i = 0; i < 5; i++) await yieldToEventLoop()
			},
			{ sleep: yieldToEventLoop },
		)
		expect(report.everReady).toBe(true)
		expect(() => report.assertNeverReady()).toThrow(OfflineAssertionError)
	})

	it('flags a ready only the in-page probe saw (a flash during a reload)', async () => {
		const page = probedPage([status('not-ready', ['shell-none'])], {
			samples: 40,
			readyObservations: 2,
			states: { 'not-ready': 38, ready: 2 },
			reasons: { 'shell-none': 38 },
		})
		const report = await expectNeverReady(page, async () => {}, { sleep: yieldToEventLoop })
		expect(report.probeRead).toBe(true)
		expect(report.everReady).toBe(true)
		expect(report.readyObservations).toBe(2)
		expect(report.statesSeen).toContain('ready')
		expect(() => report.assertNeverReady()).toThrowError(/must never be ready/)
	})

	it('stops the sampler and rethrows when the scenario fails', async () => {
		const page = probedPage([status('not-ready')])
		await expect(
			expectNeverReady(
				page,
				async () => {
					await yieldToEventLoop()
					throw new Error('scenario failed')
				},
				{ sleep: yieldToEventLoop },
			),
		).rejects.toThrow('scenario failed')
	})
})

/** A page whose reload, selector waits and status are scripted, recording the call order. */
function scriptedPage(options: {
	reloadFails?: boolean
	missingSelector?: string
	calls: string[]
}) {
	const { calls } = options
	const context = {
		async setOffline(value: boolean) {
			calls.push(value ? 'offline' : 'online')
		},
	}
	return {
		context: () => context,
		async evaluate(_fn: unknown, _arg: unknown): Promise<unknown> {
			return status('ready')
		},
		async reload() {
			calls.push('reload')
			if (options.reloadFails === true) throw new Error('net::ERR_INTERNET_DISCONNECTED')
		},
		async waitForSelector(selector: string) {
			calls.push(`wait:${selector}`)
			if (selector === options.missingSelector) throw new Error('timeout')
		},
	} as unknown as Page
}

describe('assertReadyMeansOffline', () => {
	it('runs ready, offline reload, write, second reload, verify, then restores the network', async () => {
		const calls: string[] = []
		const page = scriptedPage({ calls })
		const report = await assertReadyMeansOffline(page, {
			shellSelector: '#app',
			dataSelector: '.row',
			write: async () => {
				calls.push('write')
			},
			verifyWrite: async () => {
				calls.push('verify')
				return true
			},
			onOnline: async () => {
				calls.push('hook')
			},
		})
		expect(calls).toEqual([
			'offline',
			'reload',
			'wait:#app',
			'wait:.row',
			'write',
			'reload',
			'wait:#app',
			'wait:.row',
			'verify',
			'online',
			'hook',
		])
		expect(report.steps).toEqual([
			'ready',
			'shell and data after offline reload',
			'offline write',
			'write survives reload',
			'online hook',
		])
	})

	it('names the broken promise when the offline reload fails, and still restores the network', async () => {
		const calls: string[] = []
		const page = scriptedPage({ calls, reloadFails: true })
		await expect(
			assertReadyMeansOffline(page, { write: async () => {}, verifyWrite: async () => true }),
		).rejects.toMatchObject({ code: 'OFFLINE_RELOAD_FAILED' })
		expect(calls.at(-1)).toBe('online')
	})

	it('reports missing shell and missing data separately', async () => {
		const shell = scriptedPage({ calls: [], missingSelector: '#app' })
		await expect(
			assertReadyMeansOffline(shell, {
				shellSelector: '#app',
				write: async () => {},
				verifyWrite: async () => true,
			}),
		).rejects.toMatchObject({ code: 'SHELL_MISSING' })
		const data = scriptedPage({ calls: [], missingSelector: '.row' })
		await expect(
			assertReadyMeansOffline(data, {
				dataSelector: '.row',
				write: async () => {},
				verifyWrite: async () => true,
			}),
		).rejects.toMatchObject({ code: 'DATA_MISSING' })
	})

	it('reports a failed and a lost write', async () => {
		const failing = scriptedPage({ calls: [] })
		await expect(
			assertReadyMeansOffline(failing, {
				write: async () => {
					throw new Error('quota')
				},
				verifyWrite: async () => true,
			}),
		).rejects.toMatchObject({ code: 'OFFLINE_WRITE_FAILED' })
		const lost = scriptedPage({ calls: [] })
		await expect(
			assertReadyMeansOffline(lost, { write: async () => {}, verifyWrite: async () => false }),
		).rejects.toMatchObject({ code: 'OFFLINE_WRITE_LOST' })
	})

	it('fails with READY_TIMEOUT when the app never becomes ready', async () => {
		const calls: string[] = []
		const page = {
			...(scriptedPage({ calls }) as object),
			evaluate: async () => status('not-ready', ['shell-none']),
		} as unknown as Page
		let clock = 0
		await expect(
			assertReadyMeansOffline(page, {
				write: async () => {},
				verifyWrite: async () => true,
				timeoutMs: 10,
				now: () => clock,
				sleep: async (ms) => {
					clock += ms
				},
			}),
		).rejects.toMatchObject({ code: 'READY_TIMEOUT' })
		expect(calls).toEqual([])
	})
})
