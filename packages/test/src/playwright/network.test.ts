import type { BrowserContext, Page } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import {
	NETWORK_PRESETS,
	goOffline,
	goOnline,
	killTab,
	resolveNetworkConditions,
	throttleNetwork,
} from './network'

interface FakeContext {
	offline: boolean[]
	setOffline(value: boolean): Promise<void>
}

function fakeContext(): FakeContext {
	const offline: boolean[] = []
	return {
		offline,
		async setOffline(value) {
			offline.push(value)
		},
	}
}

describe('goOffline / goOnline', () => {
	it('switches the context when given a context', async () => {
		const context = fakeContext()
		await goOffline(context as unknown as BrowserContext)
		await goOnline(context as unknown as BrowserContext)
		expect(context.offline).toEqual([true, false])
	})

	it('switches the page context when given a page', async () => {
		const context = fakeContext()
		const page = { context: () => context } as unknown as Page
		await goOffline(page)
		expect(context.offline).toEqual([true])
	})
})

describe('network presets', () => {
	it('slow-4g is 1.6 Mbps down, 750 kbps up, 150 ms', () => {
		const p = NETWORK_PRESETS['slow-4g']
		expect(p.latencyMs).toBe(150)
		expect(p.downloadBytesPerSecond).toBe((1.6 * 1024 * 1024) / 8)
		expect(p.uploadBytesPerSecond).toBe((750 * 1024) / 8)
		expect(p.offline).toBe(false)
	})

	it('orders presets from fastest to slowest', () => {
		const down = (name: 'slow-4g' | 'fast-3g' | 'slow-3g' | '2g') =>
			NETWORK_PRESETS[name].downloadBytesPerSecond
		expect(down('slow-4g')).toBeGreaterThanOrEqual(down('fast-3g'))
		expect(down('fast-3g')).toBeGreaterThan(down('slow-3g'))
		expect(down('slow-3g')).toBeGreaterThan(down('2g'))
	})

	it('offline cuts the network and none lifts every limit', () => {
		expect(NETWORK_PRESETS.offline.offline).toBe(true)
		expect(NETWORK_PRESETS.none).toMatchObject({
			offline: false,
			downloadBytesPerSecond: -1,
			uploadBytesPerSecond: -1,
		})
	})

	it('resolveNetworkConditions passes custom conditions through and rejects unknown names', () => {
		const custom = {
			offline: false,
			latencyMs: 1,
			downloadBytesPerSecond: 2,
			uploadBytesPerSecond: 3,
		}
		expect(resolveNetworkConditions(custom)).toBe(custom)
		expect(() => resolveNetworkConditions('dial-up' as never)).toThrow(/Unknown network preset/)
	})
})

describe('throttleNetwork', () => {
	it('sends the preset over CDP and reset removes it once', async () => {
		const sent: Array<{ method: string; params?: unknown }> = []
		let detached = 0
		const session = {
			send: async (method: string, params?: unknown) => {
				sent.push({ method, params })
			},
			detach: async () => {
				detached += 1
			},
		}
		const page = { context: () => ({ newCDPSession: async () => session }) } as unknown as Page
		const throttle = await throttleNetwork(page, 'slow-4g')
		expect(sent.at(-1)).toEqual({
			method: 'Network.emulateNetworkConditions',
			params: {
				offline: false,
				latency: 150,
				downloadThroughput: (1.6 * 1024 * 1024) / 8,
				uploadThroughput: (750 * 1024) / 8,
			},
		})
		await throttle.reset()
		await throttle.reset()
		expect(sent.at(-1)?.params).toEqual({
			offline: false,
			latency: 0,
			downloadThroughput: -1,
			uploadThroughput: -1,
		})
		expect(detached).toBe(1)
	})
})

describe('killTab', () => {
	it('refuses engines other than Chromium', async () => {
		const page = {
			context: () => ({ browser: () => ({ browserType: () => ({ name: () => 'firefox' }) }) }),
		} as unknown as Page
		await expect(killTab(page)).rejects.toMatchObject({ code: 'CRASH_UNSUPPORTED' })
	})
})
