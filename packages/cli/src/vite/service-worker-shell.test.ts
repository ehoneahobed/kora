import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_SW_BYPASS, registrationScript, serviceWorkerSource } from './service-worker'

/**
 * The shell status protocol (offline-readiness design, section 7): the generated worker
 * answers `KORA_SW_STATUS`, heals only with digest-verified bytes, and the registration
 * script turns the answer into the `__KORA_SHELL__` contract.
 */

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex')

interface FakeResponse {
	ok: boolean
	type: string
	redirected: boolean
	body: string
	headers: { get(name: string): string | null }
	text(): Promise<string>
	arrayBuffer(): Promise<ArrayBuffer>
	clone(): FakeResponse
}

const respond = (body: string, ok = true): FakeResponse => ({
	ok,
	type: 'basic',
	redirected: false,
	body,
	headers: { get: () => 'application/octet-stream' },
	text: async () => body,
	arrayBuffer: async () => {
		const bytes = new TextEncoder().encode(body)
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
	},
	clone: () => respond(body, ok),
})

type Handler = (event: unknown) => void

interface WorkerOptions {
	/** The files of this build, by URL path. */
	files: Record<string, string>
	/** What the network serves now (by path); null: offline. */
	network: Record<string, string> | null
	/** Omit the build-time digests (a worker generated without them). */
	digests?: boolean
	/** Paths missing from Cache Storage after install (evicted or deleted). */
	missing?: string[]
	/**
	 * The host sends `Vary: Origin`: the install-time copies were fetched without an Origin
	 * header, so a lookup for a request that carries one misses unless it ignores Vary.
	 */
	varyOrigin?: boolean
}

function shellWorker(options: WorkerOptions) {
	const handlers = new Map<string, Handler>()
	const cache = new Map<string, string>()
	const fetched: Array<{ path: string; cache: string | undefined }> = []
	let network = options.network
	for (const [path, body] of Object.entries(options.files)) cache.set(path, body)
	for (const path of options.missing ?? []) cache.delete(path)

	const pathOf = (req: string | { url: string }): string =>
		new URL(typeof req === 'string' ? req : req.url, 'https://app.test').pathname
	const cacheApi = {
		match: async (
			req: string | { url: string; headers?: Record<string, string> },
			matchOptions?: { ignoreVary?: boolean },
		) => {
			const carriesOrigin = typeof req !== 'string' && req.headers?.origin !== undefined
			if (options.varyOrigin === true && carriesOrigin && matchOptions?.ignoreVary !== true) {
				return undefined
			}
			const body = cache.get(pathOf(req))
			return body === undefined ? undefined : respond(body)
		},
		put: async (req: string | { url: string }, response: FakeResponse) => {
			cache.set(pathOf(req), await response.text())
		},
		addAll: async () => undefined,
	}
	class FakeRequest {
		url: string
		cache: string | undefined
		constructor(url: string, init?: { cache?: string }) {
			this.url = new URL(url, 'https://app.test').href
			this.cache = init?.cache
		}
	}
	const fetchFn = async (req: FakeRequest) => {
		const url = new URL(req.url)
		fetched.push({ path: url.pathname, cache: req.cache })
		const body = url.origin === 'https://app.test' ? network?.[url.pathname] : undefined
		if (network === null || body === undefined) throw new TypeError('Failed to fetch')
		return respond(body)
	}
	const source = serviceWorkerSource({
		version: 'v1',
		precache: Object.keys(options.files),
		...(options.digests === false
			? {}
			: {
					digests: Object.fromEntries(
						Object.entries(options.files).map(([path, body]) => [path, sha256(body)]),
					),
				}),
		shellUrl: '/index.html',
		bypass: [...DEFAULT_SW_BYPASS],
		navigationTimeoutMs: 4000,
	})
	new Function('self', 'caches', 'fetch', 'Request', 'URL', 'Response', source)(
		{
			location: { origin: 'https://app.test' },
			addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
			skipWaiting: () => undefined,
			clients: { claim: async () => undefined },
		},
		{ open: async () => cacheApi, keys: async () => [], delete: async () => true },
		fetchFn,
		FakeRequest,
		URL,
		{ error: () => respond('', false) },
	)

	const ask = async (pages?: string[]): Promise<Record<string, unknown>> => {
		let reply: Record<string, unknown> | null = null
		let done: Promise<unknown> = Promise.resolve()
		handlers.get('message')?.({
			data: { type: 'KORA_SW_STATUS', ...(pages ? { pages } : {}) },
			ports: [
				{
					postMessage: (message: Record<string, unknown>) => {
						reply = message
					},
				},
			],
			waitUntil: (promise: Promise<unknown>) => {
				done = promise
			},
		})
		await done
		if (reply === null) throw new Error('the worker did not reply')
		return reply
	}
	const get = async (
		url: string,
		clientId = '',
		headers?: Record<string, string>,
	): Promise<'served' | 'failed'> => {
		let result: Promise<unknown> | null = null
		handlers.get('fetch')?.({
			clientId,
			request: { method: 'GET', mode: 'no-cors', url, ...(headers ? { headers } : {}) },
			respondWith: (promise: Promise<unknown>) => {
				result = promise
			},
		})
		if (result === null) return 'served'
		try {
			const response = (await result) as FakeResponse
			return response.ok ? 'served' : 'failed'
		} catch {
			return 'failed'
		}
	}
	return {
		ask,
		get,
		cache,
		fetched,
		setNetwork: (next: Record<string, string> | null) => {
			network = next
		},
	}
}

const build = {
	'/index.html': '<html>v1</html>',
	'/assets/app-Ab12Cd34.js': 'app js v1',
	'/assets/app-Ab12Cd34.css': 'app css v1',
	'/assets/sqlite3.wasm': 'wasm v1',
}

describe('generated worker: hosts that send Vary: Origin', () => {
	test('an offline crossorigin module script is served from the precache', async () => {
		// Found by the offline-readiness suite (A7) on every template served by `vite preview`: the
		// page's <script type="module" crossorigin> carries an Origin header, the install-time copy
		// does not, and a strict cache lookup missed, so a reload of a "ready" app failed offline.
		const sw = shellWorker({ files: build, network: null, varyOrigin: true })
		const script = 'https://app.test/assets/app-Ab12Cd34.js'
		expect(await sw.get(script, 'client', { origin: 'https://app.test' })).toBe('served')
		expect(
			await sw.get('https://app.test/assets/sqlite3.wasm', 'client', {
				origin: 'https://app.test',
			}),
		).toBe('served')
		// The status check judges the cache the same way requests do.
		expect(await sw.ask()).toMatchObject({ complete: true, missing: 0 })
	})
})

describe('generated worker: KORA_SW_STATUS', () => {
	test('a complete cache replies complete with the version and no heal traffic', async () => {
		const sw = shellWorker({ files: build, network: build })
		expect(await sw.ask()).toEqual({
			v: 1,
			version: 'v1',
			complete: true,
			missing: 0,
			misses: [],
			sameBuild: true,
		})
		expect(sw.fetched).toEqual([])
	})

	test('a missing hashed entry is refetched with cache: reload and stored when the digest matches', async () => {
		const sw = shellWorker({
			files: build,
			network: build,
			missing: ['/assets/app-Ab12Cd34.js'],
		})
		const reply = await sw.ask()
		expect(reply).toMatchObject({ complete: true, missing: 0 })
		expect(sw.cache.get('/assets/app-Ab12Cd34.js')).toBe('app js v1')
		expect(sw.fetched).toEqual([{ path: '/assets/app-Ab12Cd34.js', cache: 'reload' }])
	})

	test('a lost index.html is healed from the network only while it is still this build', async () => {
		const same = shellWorker({ files: build, network: build, missing: ['/index.html'] })
		expect(await same.ask()).toMatchObject({ complete: true })

		// A newer deployment now serves different bytes at the mutable URL: never stored.
		const newer = shellWorker({
			files: build,
			network: { ...build, '/index.html': '<html>v2</html>' },
			missing: ['/index.html'],
		})
		expect(await newer.ask()).toMatchObject({ complete: false, missing: 1 })
		expect(newer.cache.has('/index.html')).toBe(false)
		// Asking again re-checks, still never storing the newer bytes.
		expect(await newer.ask()).toMatchObject({ complete: false, missing: 1 })
		expect(newer.cache.has('/index.html')).toBe(false)
	})

	test('the unhashed sqlite3.wasm copy with changed bytes is not stored either', async () => {
		const sw = shellWorker({
			files: build,
			network: { ...build, '/assets/sqlite3.wasm': 'wasm v2' },
			missing: ['/assets/sqlite3.wasm'],
		})
		expect(await sw.ask()).toMatchObject({ complete: false, missing: 1 })
		expect(sw.cache.has('/assets/sqlite3.wasm')).toBe(false)
	})

	test('offline: nothing to heal with, the entry stays missing', async () => {
		const sw = shellWorker({ files: build, network: null, missing: ['/assets/app-Ab12Cd34.css'] })
		expect(await sw.ask()).toMatchObject({ complete: false, missing: 1 })
	})

	test('a worker built without digests never heals (nothing is verifiable)', async () => {
		const sw = shellWorker({
			files: build,
			network: build,
			digests: false,
			missing: ['/assets/app-Ab12Cd34.js'],
		})
		expect(await sw.ask()).toMatchObject({ complete: false, missing: 1 })
		expect(sw.fetched).toEqual([])
	})

	test('a response that is an error status is not stored', async () => {
		const sw = shellWorker({ files: build, network: {}, missing: ['/index.html'] })
		expect(await sw.ask()).toMatchObject({ complete: false })
		expect(sw.cache.has('/index.html')).toBe(false)
	})

	test('concurrent checks share one heal', async () => {
		const sw = shellWorker({ files: build, network: build, missing: ['/assets/app-Ab12Cd34.js'] })
		const [a, b] = await Promise.all([sw.ask(), sw.ask()])
		expect(a).toMatchObject({ complete: true })
		expect(b).toMatchObject({ complete: true })
		expect(sw.fetched).toHaveLength(1)
	})

	test('sameBuild is false when the page runs a hashed file this build does not hold', async () => {
		const sw = shellWorker({ files: build, network: build })
		expect(await sw.ask(['/assets/app-Ab12Cd34.js', '/assets/app-Ab12Cd34.css'])).toMatchObject({
			sameBuild: true,
		})
		expect(await sw.ask(['/assets/app-Ab12Cd34.js', '/assets/app-Zz99Yy88.js'])).toMatchObject({
			sameBuild: false,
			// The cache itself is complete: this is the shift-reload online case.
			complete: true,
		})
		// Unhashed files cannot tell builds apart.
		expect(await sw.ask(['/assets/extra.js'])).toMatchObject({ sameBuild: true })
	})
})

describe('generated worker: misses', () => {
	test('same-origin GETs unserved during a network failure are recorded, without the query', async () => {
		const sw = shellWorker({ files: build, network: null })
		expect(await sw.get('https://app.test/api/items?token=secret')).toBe('failed')
		expect(await sw.get('https://app.test/assets/lazy-Qw12Er34.js')).toBe('failed')
		const reply = await sw.ask()
		expect(reply.misses).toEqual(['/api/items', '/assets/lazy-Qw12Er34.js'])
	})

	test('a cross-origin request that fails from a controlled page is recorded', async () => {
		const sw = shellWorker({ files: build, network: build })
		expect(await sw.get('https://fonts.example/css?family=Inter', 'client-1')).toBe('failed')
		expect((await sw.ask()).misses).toEqual(['https://fonts.example/css'])
	})

	test('a cross-origin request with no controlled page is left alone', async () => {
		const sw = shellWorker({ files: build, network: build })
		expect(await sw.get('https://fonts.example/css')).toBe('served')
		expect((await sw.ask()).misses).toEqual([])
	})

	test('the list is bounded and keeps the most recent, each URL once', async () => {
		const sw = shellWorker({ files: build, network: null })
		for (let i = 0; i < 80; i++) await sw.get(`https://app.test/missing/${i}`)
		await sw.get('https://app.test/missing/79')
		const misses = (await sw.ask()).misses as string[]
		expect(misses).toHaveLength(50)
		expect(misses[0]).toBe('/missing/30')
		expect(misses.at(-1)).toBe('/missing/79')
		expect(new Set(misses).size).toBe(50)
	})
})

/** The registration script run against a fake window, navigator and worker. */
describe('registration script: the __KORA_SHELL__ contract', () => {
	interface ShellValue {
		v: number
		state: string
		version: string | null
		misses: string[]
	}
	type Reply = Record<string, unknown> | 'silent'

	class FakeChannel {
		port1: { onmessage: ((event: { data: unknown }) => void) | null; close(): void } = {
			onmessage: null,
			close: () => undefined,
		}
		port2 = {
			postMessage: (data: unknown) => {
				queueMicrotask(() => this.port1.onmessage?.({ data }))
			},
		}
	}

	function setup(
		options: {
			secure?: boolean
			serviceWorker?: boolean
			reply?: Reply
			registration?: 'active' | 'installing' | 'none' | 'rejects'
			resources?: string[]
			/** `globalThis.__KORA_FIRST_DATA__` when the script runs (absent: no Kora app). */
			firstData?: 'pending' | 'done'
			/** A worker already controls the page (a warm visit). */
			controlled?: boolean
			/** The browser has requestIdleCallback (Chromium); absent: Safari. */
			idleCallbacks?: boolean
		} = {},
	) {
		const win = Object.assign(new EventTarget(), { isSecureContext: options.secure ?? true })
		const doc = Object.assign(new EventTarget(), {
			visibilityState: 'visible',
			scripts: [] as Array<{ src: string }>,
			querySelectorAll: () => [] as Array<{ href: string }>,
			getElementById: () => null,
		})
		const container = new EventTarget()
		const sent: Array<{ type: string; pages?: string[] }> = []
		const pending: Array<{ port: { postMessage(data: unknown): void }; reply: Reply }> = []
		let reply: Reply = options.reply ?? {
			v: 1,
			version: 'v1',
			complete: true,
			missing: 0,
			misses: [],
			sameBuild: true,
		}
		const active = {
			postMessage: (message: { type: string; pages?: string[] }, ports?: unknown[]) => {
				sent.push(message)
				const port = ports?.[0] as { postMessage(data: unknown): void } | undefined
				if (!port) return
				if (reply === 'silent') pending.push({ port, reply })
				else port.postMessage(reply)
			},
		}
		const registration = Object.assign(new EventTarget(), {
			active:
				options.registration === 'active' || options.registration === undefined ? active : null,
			installing: options.registration === 'installing' ? new EventTarget() : null,
			waiting: null,
			update: async () => undefined,
		})
		const registered = options.registration !== 'none' && options.registration !== 'rejects'
		let registerCalls = 0
		const swContainer = Object.assign(container, {
			controller: options.controlled === true ? {} : null,
			getRegistration: async () => (registered ? registration : undefined),
			register: async () => {
				registerCalls++
				if (options.registration === 'rejects') throw new Error('script fetch failed')
				return registration
			},
		})
		const timers: Array<{ callback: () => void; ms: number }> = []
		const idleCallbacks: Array<{ callback: () => void; timeout: number | undefined }> = []
		const g: {
			__KORA_SHELL__?: ShellValue
			__KORA_FIRST_DATA__?: { v: number; state: string }
			requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
		} = {}
		if (options.firstData) g.__KORA_FIRST_DATA__ = { v: 1, state: options.firstData }
		if (options.idleCallbacks === true) {
			g.requestIdleCallback = (callback, idleOptions) => {
				idleCallbacks.push({ callback, timeout: idleOptions?.timeout })
				return idleCallbacks.length
			}
		}
		const events: ShellValue[] = []
		win.addEventListener('kora:shell', (event) => {
			events.push((event as CustomEvent<ShellValue>).detail)
		})
		const script = registrationScript({
			swUrl: '/sw.js',
			scope: '/',
			updatePrompt: false,
			firstDataTimeoutMs: 7000,
		})
		new Function(
			'window',
			'document',
			'navigator',
			'location',
			'performance',
			'MessageChannel',
			'CustomEvent',
			'setTimeout',
			'clearTimeout',
			'setInterval',
			'console',
			'globalThis',
			script,
		)(
			win,
			doc,
			options.serviceWorker === false ? {} : { serviceWorker: swContainer },
			{
				href: 'https://app.test/',
				origin: 'https://app.test',
				protocol: 'https:',
				reload: vi.fn(),
			},
			{
				getEntriesByType: () => (options.resources ?? []).map((name) => ({ name })),
			},
			FakeChannel,
			CustomEvent,
			(callback: () => void, ms: number) => {
				timers.push({ callback, ms })
				return timers.length
			},
			(id: number) => {
				const timer = timers[id - 1]
				if (timer) timer.callback = () => undefined
			},
			() => 0,
			{ warn: () => undefined },
			g,
		)
		return {
			g,
			win,
			doc,
			swContainer,
			sent,
			events,
			load: () => win.dispatchEvent(new Event('load')),
			fireTimeout: (ms?: number) => {
				for (const timer of timers) {
					if (ms === undefined || timer.ms === ms) {
						const { callback } = timer
						timer.callback = () => undefined
						callback()
					}
				}
			},
			timerDelays: () => timers.map((timer) => timer.ms),
			fireIdle: () => {
				for (const idle of idleCallbacks.splice(0)) idle.callback()
			},
			idleTimeouts: () => idleCallbacks.map((idle) => idle.timeout),
			registered: () => registerCalls,
			answerLate: (value: Record<string, unknown>) => {
				reply = value
				for (const { port } of pending.splice(0)) port.postMessage(value)
			},
			setReply: (next: Reply) => {
				reply = next
			},
		}
	}

	const state = (g: { __KORA_SHELL__?: ShellValue }): string | undefined => g.__KORA_SHELL__?.state

	test('no service worker support, or an insecure context: unsupported', () => {
		const a = setup({ serviceWorker: false })
		expect(a.g.__KORA_SHELL__).toEqual({ v: 1, state: 'unsupported', version: null, misses: [] })
		expect(a.events).toHaveLength(1)
		const b = setup({ secure: false })
		expect(state(b.g)).toBe('unsupported')
	})

	test('a complete cache on the active worker: installed, with its version and misses', async () => {
		const s = setup({
			reply: { v: 1, version: 'abc', complete: true, missing: 0, misses: ['/x'], sameBuild: true },
		})
		expect(state(s.g)).toBe('installing')
		await vi.waitFor(() => expect(state(s.g)).toBe('installed'))
		expect(s.g.__KORA_SHELL__).toEqual({ v: 1, state: 'installed', version: 'abc', misses: ['/x'] })
		expect(s.events.at(-1)?.state).toBe('installed')
	})

	test('an incomplete cache: not-installed; another build running: other-build', async () => {
		const a = setup({
			reply: { v: 1, version: 'abc', complete: false, missing: 2, misses: [], sameBuild: true },
		})
		await vi.waitFor(() => expect(state(a.g)).toBe('not-installed'))
		expect(a.g.__KORA_SHELL__?.version).toBe('abc')
		const b = setup({
			reply: { v: 1, version: 'abc', complete: true, missing: 0, misses: [], sameBuild: false },
		})
		await vi.waitFor(() => expect(state(b.g)).toBe('other-build'))
	})

	test('no registration yet is installing; a worker still installing is installing', async () => {
		const none = setup({ registration: 'none' })
		await Promise.resolve()
		expect(state(none.g)).toBe('installing')
		const installing = setup({ registration: 'installing' })
		await vi.waitFor(() => expect(installing.sent).toEqual([]))
		expect(state(installing.g)).toBe('installing')
	})

	test('a registration that fails is not-installed', async () => {
		const s = setup({ registration: 'rejects' })
		s.load()
		await vi.waitFor(() => expect(state(s.g)).toBe('not-installed'))
	})

	test('the page sends its own same-origin scripts and styles, nothing else', async () => {
		const s = setup({
			resources: [
				'https://app.test/assets/app-Ab12Cd34.js',
				'https://app.test/assets/app-Ab12Cd34.css',
				'https://app.test/logo.png',
				'https://cdn.example/lib.js',
			],
		})
		await vi.waitFor(() => expect(s.sent).toHaveLength(1))
		expect(s.sent[0]).toEqual({
			type: 'KORA_SW_STATUS',
			pages: ['/assets/app-Ab12Cd34.js', '/assets/app-Ab12Cd34.css'],
		})
	})

	test('a worker that never answers is not-installed, and a late answer still counts', async () => {
		const s = setup({ reply: 'silent' })
		await vi.waitFor(() => expect(s.sent).toHaveLength(1))
		expect(state(s.g)).toBe('installing')
		s.fireTimeout()
		expect(state(s.g)).toBe('not-installed')
		s.answerLate({ v: 1, version: 'v9', complete: true, missing: 0, misses: [], sameBuild: true })
		await vi.waitFor(() => expect(state(s.g)).toBe('installed'))
	})

	test('re-checks on controllerchange and visibilitychange, and only then', async () => {
		const s = setup()
		await vi.waitFor(() => expect(s.sent).toHaveLength(1))
		s.load()
		await vi.waitFor(() => expect(s.sent.length).toBeGreaterThanOrEqual(2))
		const afterStart = s.sent.length
		s.swContainer.dispatchEvent(new Event('controllerchange'))
		await vi.waitFor(() => expect(s.sent).toHaveLength(afterStart + 1))
		s.doc.dispatchEvent(new Event('visibilitychange'))
		await vi.waitFor(() => expect(s.sent.length).toBeGreaterThanOrEqual(afterStart + 2))
		// A hidden tab does not ask.
		const before = s.sent.length
		s.doc.visibilityState = 'hidden'
		s.doc.dispatchEvent(new Event('visibilitychange'))
		await Promise.resolve()
		expect(s.sent).toHaveLength(before)
	})

	test('an unchanged answer publishes no event', async () => {
		const s = setup()
		await vi.waitFor(() => expect(state(s.g)).toBe('installed'))
		const count = s.events.length
		s.swContainer.dispatchEvent(new Event('controllerchange'))
		await vi.waitFor(() => expect(s.sent).toHaveLength(2))
		await Promise.resolve()
		expect(s.events).toHaveLength(count)
	})

	/** Microtasks only: lets promise chains of the script run, no timers. */
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 10; i++) await Promise.resolve()
	}

	describe('precache scheduling (first-visit parity S1)', () => {
		test('a first visit registers only after the first data, then an idle moment', async () => {
			const s = setup({ registration: 'none', firstData: 'pending', idleCallbacks: true })
			s.load()
			await settle()
			expect(s.registered()).toBe(0)
			// Still waiting: the shell is installing, never claimed installed early.
			expect(state(s.g)).toBe('installing')
			s.win.dispatchEvent(new Event('kora:first-data'))
			await settle()
			expect(s.registered()).toBe(0)
			expect(s.idleTimeouts()).toEqual([2000])
			s.fireIdle()
			await settle()
			expect(s.registered()).toBe(1)
		})

		test('the first data never coming is bounded by firstDataTimeoutMs', async () => {
			const s = setup({ registration: 'none', firstData: 'pending' })
			s.load()
			await settle()
			expect(s.registered()).toBe(0)
			expect(s.timerDelays()).toContain(7000)
			s.fireTimeout(7000)
			await settle()
			expect(s.registered()).toBe(1)
			// A late event changes nothing (registered once).
			s.win.dispatchEvent(new Event('kora:first-data'))
			await settle()
			expect(s.registered()).toBe(1)
		})

		test('the event arriving first clears the bound', async () => {
			const s = setup({ registration: 'none', firstData: 'pending' })
			s.load()
			await settle()
			s.win.dispatchEvent(new Event('kora:first-data'))
			await settle()
			expect(s.registered()).toBe(1)
			s.fireTimeout(7000)
			await settle()
			expect(s.registered()).toBe(1)
		})

		test('first data already in before load: registers at load', async () => {
			const s = setup({ registration: 'none', firstData: 'done' })
			s.load()
			await settle()
			expect(s.registered()).toBe(1)
		})

		test('no Kora app announced on the page: registers at load (after idle when available)', async () => {
			const plain = setup({ registration: 'none' })
			plain.load()
			await settle()
			expect(plain.registered()).toBe(1)
			const idle = setup({ registration: 'none', idleCallbacks: true })
			idle.load()
			await settle()
			expect(idle.registered()).toBe(0)
			idle.fireIdle()
			await settle()
			expect(idle.registered()).toBe(1)
		})

		test('a page a worker already controls (warm visit) registers at load, as before', async () => {
			const s = setup({ firstData: 'pending', controlled: true, idleCallbacks: true })
			s.load()
			await settle()
			expect(s.registered()).toBe(1)
		})

		test('nothing registers before load', async () => {
			const s = setup({ registration: 'none', firstData: 'done' })
			await settle()
			expect(s.registered()).toBe(0)
		})
	})
})

/**
 * The install (first-visit parity S1, design 5.8): the page has usually just downloaded the
 * shell, so the precache reads the HTTP cache first and downloads each distinct file at most
 * once, and never stores bytes that are not this build's.
 */
describe('generated worker: install reuses the HTTP cache', () => {
	interface InstallOptions {
		/** The files of this build, by URL path. */
		files: Record<string, string>
		/** Aliases (URL to the byte-identical URL fetched for it). */
		aliases?: Record<string, string>
		/** What the browser's HTTP cache holds (the page's own downloads), by path. */
		httpCache?: Record<string, string>
		/** What the server serves; defaults to the build. */
		network?: Record<string, string>
		/** Omit the build-time digests. */
		digests?: boolean
	}

	const pathOf = (req: string | { url: string }): string =>
		new URL(typeof req === 'string' ? req : req.url, 'https://app.test').pathname

	function installWorker(options: InstallOptions) {
		const handlers = new Map<string, Handler>()
		const stored = new Map<string, string>()
		const httpCache = new Map(Object.entries(options.httpCache ?? {}))
		const network = options.network ?? options.files
		const requests: Array<{ path: string; cache: string | undefined }> = []
		// Bodies transferred from the server (a 304 or an HTTP cache hit is not one).
		const downloads: string[] = []
		class FakeRequest {
			url: string
			cache: string | undefined
			mode: string | undefined
			constructor(url: string, init?: { cache?: string; mode?: string }) {
				this.url = new URL(url, 'https://app.test').href
				this.cache = init?.cache
				this.mode = init?.mode
			}
		}
		const fromServer = (path: string): FakeResponse => {
			const body = network[path]
			if (body === undefined) return respond('not found', false)
			downloads.push(path)
			httpCache.set(path, body)
			return respond(body)
		}
		const fetchFn = async (req: FakeRequest) => {
			const path = pathOf(req)
			requests.push({ path, cache: req.cache })
			const cached = httpCache.get(path)
			if (req.cache === 'only-if-cached') {
				if (req.mode !== 'same-origin') throw new TypeError('only-if-cached needs same-origin')
				if (cached === undefined) throw new TypeError('Failed to fetch')
				return respond(cached)
			}
			// 'default': a cached copy is revalidated (the server answers 304 when it still has
			// the same bytes, else sends the new ones).
			if (req.cache === 'default' && cached !== undefined && network[path] === cached) {
				return respond(cached)
			}
			return fromServer(path)
		}
		const cacheApi = {
			match: async (req: string | { url: string }) => {
				const body = stored.get(pathOf(req))
				return body === undefined ? undefined : respond(body)
			},
			put: async (req: string | { url: string }, response: FakeResponse) => {
				stored.set(pathOf(req), await response.text())
			},
		}
		const source = serviceWorkerSource({
			version: 'v1',
			precache: Object.keys(options.files),
			...(options.digests === false
				? {}
				: {
						digests: Object.fromEntries(
							Object.entries(options.files).map(([path, body]) => [path, sha256(body)]),
						),
					}),
			...(options.aliases ? { aliases: options.aliases } : {}),
			shellUrl: '/index.html',
			bypass: [...DEFAULT_SW_BYPASS],
			navigationTimeoutMs: 4000,
		})
		new Function('self', 'caches', 'fetch', 'Request', 'URL', 'Response', source)(
			{
				location: { origin: 'https://app.test' },
				addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
				skipWaiting: () => undefined,
				clients: { claim: async () => undefined },
			},
			{ open: async () => cacheApi, keys: async () => [], delete: async () => true },
			fetchFn,
			FakeRequest,
			URL,
			{ error: () => respond('', false) },
		)
		return {
			stored,
			requests,
			downloads,
			async install(): Promise<void> {
				let done: Promise<unknown> = Promise.resolve()
				handlers.get('install')?.({
					waitUntil: (promise: Promise<unknown>) => {
						done = promise
					},
				})
				await done
			},
			async ask(): Promise<Record<string, unknown>> {
				let reply: Record<string, unknown> | null = null
				let done: Promise<unknown> = Promise.resolve()
				handlers.get('message')?.({
					data: { type: 'KORA_SW_STATUS' },
					ports: [
						{
							postMessage: (message: Record<string, unknown>) => {
								reply = message
							},
						},
					],
					waitUntil: (promise: Promise<unknown>) => {
						done = promise
					},
				})
				await done
				if (reply === null) throw new Error('the worker did not reply')
				return reply
			},
		}
	}

	const shell = {
		'/index.html': '<html>v1</html>',
		'/assets/index-Ab12Cd34.js': 'main bundle v1',
		'/assets/sqlite3-1f8bVu-G.wasm': 'wasm v1',
		'/assets/sqlite3.wasm': 'wasm v1',
		'/assets/sqlite3-opfs-async-proxy.js': 'proxy v1',
	}
	const aliases = { '/assets/sqlite3-1f8bVu-G.wasm': '/assets/sqlite3.wasm' }

	test('what the page downloaded is taken from the HTTP cache: no second download', async () => {
		// The page fetched its entry, the unhashed WASM (what the SQLite runtime asks for) and the
		// OPFS proxy; the navigation fetched "/", not "/index.html".
		const sw = installWorker({
			files: shell,
			aliases,
			httpCache: {
				'/assets/index-Ab12Cd34.js': 'main bundle v1',
				'/assets/sqlite3.wasm': 'wasm v1',
				'/assets/sqlite3-opfs-async-proxy.js': 'proxy v1',
			},
		})
		await sw.install()
		expect(sw.downloads).toEqual(['/index.html'])
		expect([...sw.stored.keys()].sort()).toEqual(Object.keys(shell).sort())
		for (const [path, body] of Object.entries(shell)) expect(sw.stored.get(path)).toBe(body)
		// The hashed WASM name was never requested: it is stored from the one copy.
		expect(sw.requests.some((r) => r.path === '/assets/sqlite3-1f8bVu-G.wasm')).toBe(false)
		expect(sw.requests.every((r) => r.cache !== 'reload')).toBe(true)
		expect(await sw.ask()).toMatchObject({ complete: true, missing: 0 })
	})

	test('a cold HTTP cache: each distinct file downloaded exactly once, the WASM once', async () => {
		const sw = installWorker({ files: shell, aliases })
		await sw.install()
		expect(sw.downloads.sort()).toEqual([
			'/assets/index-Ab12Cd34.js',
			'/assets/sqlite3-opfs-async-proxy.js',
			'/assets/sqlite3.wasm',
			'/index.html',
		])
		expect(sw.stored.get('/assets/sqlite3-1f8bVu-G.wasm')).toBe('wasm v1')
		expect(sw.stored.get('/assets/sqlite3.wasm')).toBe('wasm v1')
	})

	test('the WASM in the HTTP cache under its hashed name only also serves the alias', async () => {
		const sw = installWorker({
			files: shell,
			aliases,
			httpCache: { '/assets/sqlite3-1f8bVu-G.wasm': 'wasm v1' },
		})
		await sw.install()
		expect(sw.downloads).not.toContain('/assets/sqlite3.wasm')
		expect(sw.downloads).not.toContain('/assets/sqlite3-1f8bVu-G.wasm')
		expect(sw.stored.get('/assets/sqlite3.wasm')).toBe('wasm v1')
	})

	test('a stale HTTP cache entry is never stored: the file is fetched past the HTTP cache', async () => {
		// The HTTP cache holds an older deploy's bytes at the mutable URLs; the server has this
		// build's bytes again (a rollback), but revalidation would not say so (a heuristic
		// freshness lifetime on a host that sends no Cache-Control).
		const sw = installWorker({
			files: shell,
			aliases,
			httpCache: { '/assets/sqlite3.wasm': 'wasm v0', '/index.html': '<html>v0</html>' },
		})
		await sw.install()
		expect(sw.stored.get('/assets/sqlite3.wasm')).toBe('wasm v1')
		expect(sw.stored.get('/assets/sqlite3-1f8bVu-G.wasm')).toBe('wasm v1')
		expect(sw.stored.get('/index.html')).toBe('<html>v1</html>')
	})

	test('bytes the revalidated HTTP cache still gets wrong are refetched with cache: reload', async () => {
		const sw = installWorker({
			files: shell,
			aliases,
			network: { ...shell, '/assets/sqlite3.wasm': 'wasm v2' },
		})
		await sw.install()
		expect(sw.requests).toContainEqual({ path: '/assets/sqlite3.wasm', cache: 'reload' })
		// What the server serves now is stored, exactly as cache.addAll stored it (unchanged
		// behavior; the shell status check judges presence, the heal judges bytes).
		expect(sw.stored.get('/assets/sqlite3.wasm')).toBe('wasm v2')
	})

	test('a worker generated without digests fetches past the HTTP cache, as before', async () => {
		const sw = installWorker({
			files: shell,
			aliases,
			digests: false,
			httpCache: { '/assets/sqlite3.wasm': 'wasm v1' },
		})
		await sw.install()
		expect(sw.requests.every((r) => r.cache === 'reload')).toBe(true)
		// Still one download for the byte-identical pair.
		expect(sw.downloads.filter((path) => path.endsWith('.wasm'))).toEqual(['/assets/sqlite3.wasm'])
	})

	test('a file the server does not serve fails the install, as addAll did', async () => {
		const { '/assets/sqlite3-opfs-async-proxy.js': _missing, ...network } = shell
		const sw = installWorker({ files: shell, aliases, network })
		await expect(sw.install()).rejects.toThrow(/sqlite3-opfs-async-proxy\.js/)
	})

	test('an alias lost from Cache Storage is healed from its twin without the network', async () => {
		const sw = installWorker({ files: shell, aliases })
		await sw.install()
		sw.stored.delete('/assets/sqlite3-1f8bVu-G.wasm')
		const before = sw.requests.length
		expect(await sw.ask()).toMatchObject({ complete: true, missing: 0 })
		expect(sw.stored.get('/assets/sqlite3-1f8bVu-G.wasm')).toBe('wasm v1')
		expect(sw.requests).toHaveLength(before)
	})
})
