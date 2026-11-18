import { afterEach, describe, expect, it } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { withHostSettings } from './host-settings'
import { type ProductionServer, createProductionServer } from './production-server'
import type { TrustProxySetting } from './trust-proxy'

/**
 * `trustProxy: 0` and `trustProxy: []` trust no proxy, exactly like leaving it unset (as
 * `KORA_TRUST_PROXY=0` already does): the server must not treat the socket address as a real
 * client address, and must warn that per-address protection is off. Treating them as set would
 * give every client behind a proxy one shared per-address slot and sign-in failure bucket,
 * silently.
 */
const trustsNone: Array<[string, TrustProxySetting]> = [
	['0', 0],
	['-1', -1],
	['[]', []],
]

describe('trustProxy values that trust no proxy are unset', () => {
	it.each(trustsNone)(
		'withHostSettings drops trustProxy %s (and does not take the env instead)',
		(_label, value) => {
			const store = new MemoryServerStore('s')
			expect(withHostSettings({ store, trustProxy: value }, {}).trustProxy).toBeUndefined()
			expect(
				withHostSettings({ store, trustProxy: value }, { KORA_TRUST_PROXY: '2' }).trustProxy,
			).toBeUndefined()
		},
	)

	it('a real setting is kept', () => {
		const store = new MemoryServerStore('s')
		expect(withHostSettings({ store, trustProxy: 1 }, {}).trustProxy).toBe(1)
		expect(withHostSettings({ store, trustProxy: ['10.0.0.0/8'] }, {}).trustProxy).toEqual([
			'10.0.0.0/8',
		])
	})
})

let running: ProductionServer | null = null
afterEach(async () => {
	await running?.stop()
	running = null
})

describe('the production server warns when trustProxy trusts no proxy', () => {
	it.each(trustsNone)(
		'trustProxy %s logs read.trust_proxy_unset at start',
		async (_label, value) => {
			const logs: Array<{ event: string }> = []
			running = createProductionServer({
				store: new MemoryServerStore('s'),
				port: 0,
				staticDir: '/nonexistent',
				trustProxy: value,
				syncOptions: { logger: { log: (entry) => logs.push(entry) } },
			})
			await running.start()
			expect(logs.map((entry) => entry.event)).toContain('read.trust_proxy_unset')
		},
	)
})
