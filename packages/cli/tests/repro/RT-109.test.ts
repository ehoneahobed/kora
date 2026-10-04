/**
 * RT-109 repro (final verification round, NEW-DX-3 offline app shell): the "update waits
 * for consent" flow is not what the page runs. After a deploy, the OLD worker stays active
 * and the new one waits, but navigations are network-first: an online reload runs the NEW
 * build (its index.html from the network, its hashed chunks fetched through the old
 * worker) while the page shows "A new version is available". A later OFFLINE reload of the
 * same tab is answered from the old worker's cache with the OLD shell, so the OLD build
 * runs against a database the new build already opened and migrated.
 *
 * Verified end to end in Chromium on a scaffolded react-tailwind-sync app (packed beta.13
 * tarballs): v1 online -> deploy v2 (title + schema version 2) -> online reload shows v2
 * with the update prompt visible and the registration `{active, waiting}` -> offline
 * reload shows v1, which opens the schema-2 database without a complaint
 * (`runSchemaMigrations` returns when stored >= target, store/src/migrations/run-migrations.ts:47)
 * and writes schema-1 operations. With a `renameField` migration the old build fails at
 * `ready` (RC red-team probe), i.e. the offline app does not open until the device is
 * online again. Script: packages/cli/tests/repro/RT-109-browser.mjs.
 *
 * This test runs the generated worker's fetch handler in a minimal fake
 * ServiceWorkerGlobalScope and asserts CORRECT behaviour: while this worker version is
 * the active one, a navigation never yields a shell of another build (online it serves
 * its own precached shell, or the network shell only when it belongs to this version).
 */
import { describe, expect, test } from 'vitest'
import { DEFAULT_SW_BYPASS, serviceWorkerSource } from '../../src/vite/service-worker'

type Handler = (event: unknown) => void

function loadWorker(version: string, shells: Map<string, string>, network: () => string | null) {
	const handlers = new Map<string, Handler>()
	const caches = new Map<string, Map<string, string>>()
	const cacheFor = (name: string) => {
		let cache = caches.get(name)
		if (!cache) {
			cache = new Map()
			caches.set(name, cache)
		}
		return cache
	}
	const response = (body: string) => ({
		ok: true,
		type: 'basic',
		body,
		clone: () => response(body),
	})
	const scope = {
		location: { origin: 'https://app.test' },
		addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
		skipWaiting: () => undefined,
		clients: { claim: async () => undefined },
	}
	const cachesApi = {
		open: async (name: string) => {
			const cache = cacheFor(name)
			return {
				match: async (req: string | { url: string }) => {
					const key = typeof req === 'string' ? req : new URL(req.url).pathname
					const body = cache.get(key)
					return body === undefined ? undefined : response(body)
				},
				put: async (req: { url: string }, res: { body: string }) => {
					cache.set(new URL(req.url).pathname, res.body)
				},
				addAll: async (requests: Array<{ url: string }>) => {
					for (const r of requests) {
						const path = new URL(r.url, 'https://app.test').pathname
						cache.set(path, shells.get(path) ?? '')
					}
				},
			}
		},
		keys: async () => [...caches.keys()],
		delete: async (name: string) => caches.delete(name),
	}
	const fetchFn = async () => {
		const body = network()
		if (body === null) throw new TypeError('Failed to fetch')
		return response(body)
	}
	class FakeRequest {
		url: string
		constructor(url: string) {
			this.url = new URL(url, 'https://app.test').href
		}
	}
	const source = serviceWorkerSource({
		version,
		precache: ['/index.html'],
		shellUrl: '/index.html',
		bypass: [...DEFAULT_SW_BYPASS],
		navigationTimeoutMs: 4000,
	})
	new Function('self', 'caches', 'fetch', 'Request', 'URL', 'setTimeout', 'clearTimeout', source)(
		scope,
		cachesApi,
		fetchFn,
		FakeRequest,
		URL,
		setTimeout,
		clearTimeout,
	)
	return {
		async install() {
			let done: Promise<unknown> = Promise.resolve()
			handlers.get('install')?.({
				waitUntil: (p: Promise<unknown>) => {
					done = p
				},
			})
			await done
		},
		async navigate(): Promise<string | undefined> {
			let result: Promise<{ body: string } | undefined> = Promise.resolve(undefined)
			handlers.get('fetch')?.({
				request: { method: 'GET', mode: 'navigate', url: 'https://app.test/' },
				respondWith: (p: Promise<{ body: string } | undefined>) => {
					result = p
				},
			})
			return (await result)?.body
		},
	}
}

describe('RT-109: the active (old) worker runs whichever build the network has', () => {
	test('online navigation after a deploy is the new build; offline is the old one', async () => {
		let deployed = '<html>build v2</html>'
		let online = true
		// Worker v1 installed and active, its cache holds the v1 shell.
		const v1 = loadWorker('v1', new Map([['/index.html', '<html>build v1</html>']]), () =>
			online ? deployed : null,
		)
		await v1.install()

		// v2 is deployed; the v2 worker is waiting for the user's consent (not activated).
		deployed = '<html>build v2</html>'
		const onlineShell = await v1.navigate()
		online = false
		const offlineShell = await v1.navigate()

		// Correct: one active worker serves one build, online and offline alike.
		expect(onlineShell).toBe(offlineShell)
	})
})
