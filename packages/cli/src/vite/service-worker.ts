import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { devBuildId, isUnhashed, stampOutputBuildId, withBuildIdTag } from './build-id'

export {
	BUILD_ID_PLACEHOLDER,
	BUILD_META_NAME,
	type BuildIdHtmlTag,
	type KoraBuildIdPlugin,
	koraBuildId,
	outputBuildId,
	stampBuildId,
} from './build-id'

/**
 * The offline app shell for Kora apps (NEW-DX-3).
 *
 * A Kora app's DATA works offline; this makes its INTERFACE open offline too. The plugin
 * runs only in `vite build`:
 * - After the bundle is written (and after the template's sqlite WASM copy step), it walks
 *   the output directory and writes `sw.js`: a small, dependency-free service worker that
 *   precaches the built shell (index.html, hashed JS/CSS/WASM, the worker, the OPFS proxy
 *   and public files) into a cache versioned by the content of every precached file.
 * - It injects a registration script into `index.html` with a "new version available"
 *   flow: the new worker waits, the page shows a reload prompt (or dispatches
 *   `kora:update-available` for the app to show its own), and only an accepted update
 *   activates it and reloads, so old and new assets never mix in one page. On a first
 *   visit it registers the worker only after the app's first data, and the install reuses
 *   the HTTP cache, so the precache never competes with the app or downloads it twice
 *   (first-visit parity, docs/design/first-visit-parity.md section 5.8).
 *
 * In `vite dev` it injects a script that unregisters any Kora service worker left on the
 * dev origin, so a stale shell can never shadow the dev server.
 *
 * Built in-house instead of `vite-plugin-pwa` (CLAUDE.md: justify every dependency): the
 * whole worker is under 150 lines, needs no Workbox runtime, and its caching rules are the
 * ones a Kora app specifically needs (never cache the sync endpoint or auth routes; never
 * serve an unhashed file such as `assets/sqlite3.wasm` cache-first).
 */
export interface KoraServiceWorkerOptions {
	/**
	 * URL path prefixes the worker never handles (always straight to the network, never
	 * cached). Defaults to the sync endpoint, auth routes and server operational endpoints:
	 * `['/kora-sync', '/auth', '/__kora', '/health']`.
	 */
	bypass?: string[]
	/**
	 * Show the built-in "new version available" banner. Defaults to true. Set false to show
	 * your own UI: listen for the `kora:update-available` window event and call
	 * `event.detail.update()` when the user accepts.
	 */
	updatePrompt?: boolean
	/**
	 * A navigation waits this long for the network before the cached shell is served
	 * (a captive portal or a stalled 2G link otherwise leaves a blank page). Defaults to 4000.
	 */
	navigationTimeoutMs?: number
	/** File name of the generated worker, relative to the output directory. Defaults to `sw.js`. */
	fileName?: string
	/**
	 * Inject the build id Kora's version gate uses (`<meta name="kora-build">`, a hash of the
	 * emitted bundle; see `koraBuildId()`). Defaults to true.
	 */
	buildId?: boolean
	/**
	 * On a first visit (a page no service worker controls yet) the worker is registered, and
	 * the shell precached, only after the app's first data (the `kora:first-data` event
	 * `korajs` dispatches), so the precache never competes with it for the network. This is
	 * the longest that registration waits for that event after `load` before it goes ahead
	 * anyway (an app that never connects sync, an older `korajs`). Defaults to 10000.
	 */
	firstDataTimeoutMs?: number
}

/** The subset of Vite's resolved config this plugin reads. */
interface ResolvedViteConfig {
	root: string
	base: string
	command: 'build' | 'serve'
	build: { outDir: string }
}

interface HtmlTag {
	tag: string
	attrs?: Record<string, string | boolean>
	children?: string
	injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend'
}

/**
 * A Vite plugin, typed structurally so `@korajs/cli` does not depend on `vite`.
 */
export interface KoraVitePlugin {
	name: string
	enforce?: 'pre' | 'post'
	configResolved(config: ResolvedViteConfig): void
	transformIndexHtml(html: string): { html: string; tags: HtmlTag[] }
	closeBundle: { order: 'post'; sequential: true; handler(): void }
}

/** Default URL prefixes the service worker never touches. */
export const DEFAULT_SW_BYPASS: readonly string[] = ['/kora-sync', '/auth', '/__kora', '/health']

/**
 * `<meta name="kora-shell">`, injected into every built HTML page: the worker recognises a
 * page of a Kora build by it (RT-109).
 */
export const SW_SHELL_META = 'kora-shell'

/** Cache-name prefix shared by every version, so `activate` can delete old versions. */
export const SW_CACHE_PREFIX = 'kora-shell-'

/** Default of {@link KoraServiceWorkerOptions.firstDataTimeoutMs}. */
export const DEFAULT_FIRST_DATA_TIMEOUT_MS = 10_000

/**
 * The window event `korajs` dispatches once the app's first data is in (first-visit parity,
 * design section 5.8). Its state is mirrored on `globalThis.__KORA_FIRST_DATA__ =
 * { v: 1, state: 'pending' | 'done' }`, so a listener added late still knows.
 */
export const FIRST_DATA_EVENT = 'kora:first-data'

/**
 * Vite plugin that gives a Kora app an offline app shell.
 *
 * @param options - Bypass prefixes, update prompt and navigation timeout
 * @returns A Vite plugin (add it last in `plugins`)
 *
 * @example
 * ```typescript
 * import { koraServiceWorker } from '@korajs/cli/vite'
 * export default defineConfig({ plugins: [react(), koraServiceWorker()] })
 * ```
 */
export function koraServiceWorker(options: KoraServiceWorkerOptions = {}): KoraVitePlugin {
	const fileName = options.fileName ?? 'sw.js'
	const bypass = options.bypass ?? [...DEFAULT_SW_BYPASS]
	const updatePrompt = options.updatePrompt ?? true
	const navigationTimeoutMs = options.navigationTimeoutMs ?? 4000
	const injectBuildId = options.buildId ?? true
	const firstDataTimeoutMs = options.firstDataTimeoutMs ?? DEFAULT_FIRST_DATA_TIMEOUT_MS
	const devId = devBuildId()
	let config: ResolvedViteConfig | null = null

	return {
		name: 'kora-service-worker',
		enforce: 'post',
		configResolved(resolved) {
			config = resolved
		},
		transformIndexHtml(source) {
			if (!config) return { html: source, tags: [] }
			// The build id tag: injected, or an existing one's content replaced.
			const page = injectBuildId
				? withBuildIdTag(source, config.command, devId)
				: { html: source, tags: [] }
			const html = page.html
			const children =
				config.command === 'build'
					? registrationScript({
							swUrl: `${config.base}${fileName}`,
							scope: config.base,
							updatePrompt,
							firstDataTimeoutMs,
						})
					: DEV_UNREGISTER_SCRIPT
			const tags: HtmlTag[] = [
				{ tag: 'script', attrs: { type: 'module' }, children, injectTo: 'body' },
			]
			tags.push(...page.tags)
			if (config.command === 'build') {
				// Marks the document as a page of a Kora build: the worker serves its OWN
				// build's copy of such a page until the user accepts an update (RT-109).
				tags.push({
					tag: 'meta',
					attrs: { name: SW_SHELL_META, content: '1' },
					injectTo: 'head-prepend',
				})
			}
			return { html, tags }
		},
		closeBundle: {
			order: 'post',
			sequential: true,
			handler() {
				if (!config || config.command !== 'build') return
				const outDir = resolve(config.root, config.build.outDir)
				// The build id first, on every page (multi-page and nested entries too, with or
				// without a root index.html): it is stamped into the pages, which are precached.
				// Only the worker this plugin generates is left out of the hash.
				if (injectBuildId) stampOutputBuildId(outDir, [fileName])
				if (!existsSync(join(outDir, 'index.html'))) return
				const { urls, version, digests, aliases } = collectPrecache(outDir, config.base, fileName)
				writeFileSync(
					join(outDir, fileName),
					serviceWorkerSource({
						version,
						precache: urls,
						digests,
						aliases,
						shellUrl: `${config.base}index.html`,
						bypass,
						navigationTimeoutMs,
					}),
				)
			},
		},
	}
}

/**
 * The files to precache from a build directory, and a version derived from their content.
 *
 * Skipped: the worker itself, source maps, pre-compressed siblings (`.br`, `.gz`), dot
 * directories (`.vite/`).
 *
 * Files with identical bytes are all precached (each URL must open offline) but downloaded
 * once: the templates copy `sqlite3-<hash>.wasm` to `sqlite3.wasm` because the SQLite
 * runtime fetches the unhashed name, and fetching both would double a ~400 KB (gzip)
 * first download on the slow links Kora targets. In each group of identical files the
 * shortest URL (the stable name a runtime asks for) is the one fetched; the others are
 * `aliases` the worker fills from its response.
 *
 * @param outDir - Absolute build directory
 * @param base - Vite `base` (URL prefix ending in `/`)
 * @param swFileName - The worker's own file name, excluded from the list
 * @returns Precache URLs (sorted), a 16-hex-digit content version, the SHA-256 (hex) of
 *   each URL's file, which the worker embeds as `DIGESTS` to verify what it stores, and the
 *   aliases (URL to the URL whose identical bytes it is stored from)
 */
export function collectPrecache(
	outDir: string,
	base: string,
	swFileName = 'sw.js',
): {
	urls: string[]
	version: string
	digests: Record<string, string>
	aliases: Record<string, string>
} {
	const files: { path: string; digest: string }[] = []
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue
			const full = join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(full)
				continue
			}
			if (!entry.isFile()) continue
			const rel = relative(outDir, full).split(sep).join('/')
			// Derived files only: sourcemaps and compressed copies of another emitted file. A
			// standalone .gz/.br asset the app fetches is precached like any other.
			if (rel === swFileName || isUnhashed(full)) continue
			files.push({
				path: rel,
				digest: createHash('sha256').update(readFileSync(full)).digest('hex'),
			})
		}
	}
	walk(outDir)

	const kept = files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

	const version = createHash('sha256')
	for (const f of kept) version.update(`${f.path}\0${f.digest}\n`)
	const digests: Record<string, string> = {}
	for (const f of kept) digests[`${base}${f.path}`] = f.digest

	// One download per distinct content: the shortest URL of each group is fetched.
	const fetchedFor = new Map<string, string>()
	for (const f of kept) {
		const url = `${base}${f.path}`
		const current = fetchedFor.get(f.digest)
		if (current === undefined || url.length < current.length) fetchedFor.set(f.digest, url)
	}
	const aliases: Record<string, string> = {}
	for (const f of kept) {
		const url = `${base}${f.path}`
		const source = fetchedFor.get(f.digest)
		if (source !== undefined && source !== url) aliases[url] = source
	}
	return {
		urls: kept.map((f) => `${base}${f.path}`),
		version: version.digest('hex').slice(0, 16),
		digests,
		aliases,
	}
}

/**
 * Vite/Rollup content-hash naming (`name-[hash].ext`): the last `-`/`.` token of the stem
 * is 8+ `[A-Za-z0-9_]` characters with an uppercase letter or digit. The same rule the
 * production server uses for `immutable` caching, so the two never disagree.
 */
export function isHashedName(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1)
	const dot = name.lastIndexOf('.')
	const stem = dot > 0 ? name.slice(0, dot) : name
	const match = /[.-]([A-Za-z0-9_]{8,})$/.exec(stem)
	return match !== null && /[A-Z0-9]/.test(match[1] as string)
}

interface WorkerSourceInput {
	version: string
	precache: string[]
	/**
	 * Build-time SHA-256 (hex) of every precached file, by URL. The worker heals a missing
	 * entry only with bytes that match; absent, it never heals (nothing is verifiable).
	 */
	digests?: Record<string, string>
	/**
	 * Precached URLs whose bytes equal another precached URL's (alias to source). Installed
	 * from the source's response instead of a second download.
	 */
	aliases?: Record<string, string>
	shellUrl: string
	bypass: string[]
	navigationTimeoutMs: number
}

/**
 * Source of the generated service worker.
 *
 * - install: precache every shell file into `kora-shell-<version>`, without downloading
 *   what the page already downloaded (first-visit parity, design section 5.8). Each file is
 *   taken, cheapest first, from the HTTP cache without touching the network
 *   (`only-if-cached`, under its own URL or a byte-identical one), then from the HTTP cache
 *   with revalidation (`cache: 'default'`), and kept only when its SHA-256 equals the
 *   build-time digest, so a stale or foreign HTTP cache entry is never stored. Otherwise,
 *   and for a worker generated without digests, it is fetched past the HTTP cache
 *   (`cache: 'reload'`) as before. Byte-identical files (the unhashed `sqlite3.wasm` copy)
 *   are fetched once and stored under every URL. It does NOT skip waiting: an update waits
 *   for the page to accept it.
 * - activate: delete every other `kora-shell-*` cache, then claim clients.
 * - fetch (same-origin GET only, bypass prefixes untouched). One build per active worker
 *   (RT-109): while this worker is active the page runs THIS worker's build, online and
 *   offline alike, until the user accepts an update (or every tab of the app closes and
 *   the waiting worker takes over at the next start):
 *   - navigations: network first (with a timeout). A page of a Kora build (it carries
 *     `<meta name="kora-shell">`) that is not byte-identical to one of this build's
 *     precached pages belongs to another build (a deploy happened): this build's copy of
 *     that page (or its shell) is served instead. Other documents (server-rendered pages,
 *     downloads) pass through. Offline or timed out: this build's copy or shell;
 *   - files this build precached: cache first (this build's bytes, the unhashed
 *     `sqlite3.wasm` and public files included, never a newer deploy's);
 *   - other content-hashed files: cache first (their bytes can never change);
 *   - everything else: network first, falling back to the cache.
 * - message `KORA_SW_STATUS` (the page's shell check, design section 7): replies
 *   `{ v: 1, version, complete, missing, misses, sameBuild }` after checking every precached
 *   URL. A missing entry is refetched (`cache: 'reload'`) and stored ONLY when its SHA-256
 *   equals the build-time digest (`DIGESTS`); bytes of a newer deployment are never stored.
 */
export function serviceWorkerSource(input: WorkerSourceInput): string {
	return `// Generated by @korajs/cli koraServiceWorker(). Do not edit: rebuilt on every \`vite build\`.
const VERSION = ${JSON.stringify(input.version)}
const CACHE = ${JSON.stringify(SW_CACHE_PREFIX)} + VERSION
const PRECACHE = ${JSON.stringify(input.precache)}
const SHELL = ${JSON.stringify(input.shellUrl)}
const BYPASS = ${JSON.stringify(input.bypass)}
const NAVIGATION_TIMEOUT_MS = ${JSON.stringify(input.navigationTimeoutMs)}
const PRECACHED = new Set(PRECACHE)
const PAGES = PRECACHE.filter((url) => /\.html?$/i.test(url))
const SHELL_MARKER = ${JSON.stringify(`name="${SW_SHELL_META}"`)}
const DIGESTS = ${JSON.stringify(input.digests ?? {})}
// URL -> the precached URL with the same bytes that is downloaded for it.
const ALIASES = ${JSON.stringify(input.aliases ?? {})}
const MAX_MISSES = 50
const MAX_PAGE_URLS = 500

// The precached URLs holding the same bytes as url (url excluded).
function sameBytes(url) {
	const source = ALIASES[url] || url
	return [source, ...Object.keys(ALIASES).filter((alias) => ALIASES[alias] === source)].filter(
		(other) => other !== url,
	)
}

// A copy of response when it is a usable answer whose bytes are this build's; else null.
async function verified(response, expected) {
	if (!response || !response.ok || response.redirected) return null
	const copy = response.clone()
	return (await sha256Hex(await response.arrayBuffer())) === expected ? copy : null
}

async function tryFetch(request, expected) {
	try {
		return await verified(await fetch(request), expected)
	} catch (error) {
		// Not in the HTTP cache (only-if-cached answers with an error), or offline.
		return null
	}
}

// One shell file for the install, cheapest first. The page has usually just downloaded it:
// the HTTP cache answers without the network, or revalidates (a 304, no body). Bytes are
// stored only when they are this build's, so a stale HTTP cache entry is never kept.
async function shellResponse(url) {
	const expected = DIGESTS[url]
	if (typeof expected === 'string') {
		for (const candidate of [url, ...sameBytes(url)]) {
			const cached = await tryFetch(
				new Request(candidate, { cache: 'only-if-cached', mode: 'same-origin' }),
				expected,
			)
			if (cached) return cached
		}
		const revalidated = await tryFetch(new Request(url, { cache: 'default' }), expected)
		if (revalidated) return revalidated
	}
	// Nothing verifiable, or the HTTP cache had other bytes: from the server, as addAll did.
	const response = await fetch(new Request(url, { cache: 'reload' }))
	if (!response.ok) throw new TypeError('Precaching ' + url + ' failed: HTTP ' + response.status)
	return response
}

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE).then((cache) =>
			Promise.all(
				PRECACHE.filter((url) => !(url in ALIASES)).map(async (url) => {
					const response = await shellResponse(url)
					const aliases = Object.keys(ALIASES).filter((alias) => ALIASES[alias] === url)
					// Every byte-identical URL is stored from this one download.
					for (const alias of aliases) await cache.put(alias, response.clone())
					await cache.put(url, response)
				}),
			),
		),
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key.startsWith(${JSON.stringify(SW_CACHE_PREFIX)}) && key !== CACHE)
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => self.clients.claim()),
	)
})

// Diagnostic only: same-origin GETs this worker could not serve while the network failed, and
// cross-origin requests that failed from a controlled page (a font CDN shows up here). Query
// strings are dropped (they carry tokens); the list is bounded and kept in memory, so a worker
// the browser terminated forgets it.
const misses = []
function recordMiss(url) {
	const key = (url.origin === self.location.origin ? url.pathname : url.origin + url.pathname).slice(0, 200)
	const at = misses.indexOf(key)
	if (at !== -1) misses.splice(at, 1)
	misses.push(key)
	if (misses.length > MAX_MISSES) misses.shift()
}

// Cached responses are looked up ignoring Vary. A host that sends "Vary: Origin" (vite preview,
// CDNs with CORS rules) makes the install-time copy (fetched without an Origin header) a
// different variant from the one the page's own crossorigin module scripts ask for (they carry
// an Origin header): a strict lookup misses, the worker falls through to the network, and an offline reload
// of an app reported as ready fails. Every precached URL maps to exactly one file of this build.
const MATCH = { ignoreVary: true }

async function missingEntries(cache) {
	const missing = []
	for (const url of PRECACHE) {
		if (!(await cache.match(url, MATCH))) missing.push(url)
	}
	return missing
}

async function sha256Hex(buffer) {
	const digest = await crypto.subtle.digest('SHA-256', buffer)
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Restore one missing entry from a byte-identical cached one, else refetch it past the HTTP
// cache, and store it ONLY when its bytes are the ones
// this build was made from. A mutable URL (index.html, the unhashed sqlite3.wasm copy, the
// manifest) may already serve a newer deployment: those bytes are never written into this
// build's cache and the entry stays missing, so one active worker never mixes two builds.
async function healEntry(cache, url) {
	const expected = DIGESTS[url]
	if (typeof expected !== 'string') return
	// A byte-identical entry still in the cache heals it without the network.
	for (const other of sameBytes(url)) {
		const copy = await verified(await cache.match(other, MATCH), expected)
		if (copy) return cache.put(url, copy)
	}
	try {
		const response = await fetch(new Request(url, { cache: 'reload' }))
		if (!response.ok || response.redirected) return
		const copy = response.clone()
		if ((await sha256Hex(await response.arrayBuffer())) !== expected) return
		await cache.put(url, copy)
	} catch (error) {
		// Offline (or the file is gone): it stays missing and the page reports it.
	}
}

let inflight = null
// Concurrent checks (several tabs) share one verify-and-heal pass.
function verifyShell() {
	if (inflight === null) {
		inflight = (async () => {
			const cache = await caches.open(CACHE)
			let missing = await missingEntries(cache)
			if (missing.length > 0) {
				for (const url of missing) await healEntry(cache, url)
				missing = await missingEntries(cache)
			}
			return missing.length
		})().finally(() => {
			inflight = null
		})
	}
	return inflight
}

// The page's own hashed scripts and styles must all belong to this build; otherwise an
// offline reload would run this worker's older build against a database the page may have
// migrated (design 7, "Same build").
function sameBuild(pages) {
	if (!Array.isArray(pages)) return true
	return pages
		.slice(0, MAX_PAGE_URLS)
		.every((path) => typeof path !== 'string' || !isHashed(path) || PRECACHED.has(path))
}

function shellStatus(pages) {
	return verifyShell().then(
		(missing) => ({
			v: 1,
			version: VERSION,
			complete: missing === 0,
			missing,
			misses: misses.slice(),
			sameBuild: sameBuild(pages),
		}),
		() => ({
			v: 1,
			version: VERSION,
			complete: false,
			missing: PRECACHE.length,
			misses: misses.slice(),
			sameBuild: sameBuild(pages),
		}),
	)
}

self.addEventListener('message', (event) => {
	const data = event.data
	if (!data) return
	if (data.type === 'KORA_SW_SKIP_WAITING') self.skipWaiting()
	if (data.type === 'KORA_SW_STATUS') {
		const port = event.ports && event.ports[0]
		const reply = (message) => {
			if (port) port.postMessage(message)
			else if (event.source) event.source.postMessage(message)
		}
		event.waitUntil(shellStatus(data.pages).then(reply))
	}
})

function isHashed(pathname) {
	const name = pathname.slice(pathname.lastIndexOf('/') + 1)
	const match = /[.-]([A-Za-z0-9_]{8,})\\.[A-Za-z0-9]+$/.exec(name)
	return match !== null && /[A-Z0-9]/.test(match[1])
}

function fromCache(request) {
	return caches.open(CACHE).then((cache) => cache.match(request, { ignoreSearch: true, ignoreVary: true }))
}

// This build's copy of the page a navigation asked for: the precached page of that path,
// else the app shell (client-side routes).
function ownPage(url) {
	return caches.open(CACHE).then((cache) =>
		(PAGES.includes(url.pathname) ? cache.match(url.pathname, MATCH) : Promise.resolve(undefined)).then(
			(page) => page || cache.match(SHELL, MATCH),
		),
	)
}

// A navigation the network answered: kept when it is not a Kora page or is one of THIS
// build's pages; a page of another build (a newer deploy) is replaced by this build's
// copy, so one active worker serves one build (RT-109).
async function sameBuildOrOwn(url, response) {
	const type = (response.headers && response.headers.get('content-type')) || ''
	if (!response.ok || !/html/i.test(type)) return response
	const text = await response.clone().text()
	if (!text.includes(SHELL_MARKER)) return response
	const cache = await caches.open(CACHE)
	for (const page of PAGES) {
		const cached = await cache.match(page, MATCH)
		if (cached && (await cached.text()) === text) return response
	}
	return (await ownPage(url)) || response
}

function networkWithTimeout(request, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timeout')), ms)
		fetch(request).then(
			(response) => {
				clearTimeout(timer)
				resolve(response)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

self.addEventListener('fetch', (event) => {
	const request = event.request
	if (request.method !== 'GET') return
	const url = new URL(request.url)
	if (url.origin !== self.location.origin) {
		// Observed, never cached or answered differently: a cross-origin request that fails
		// from a page this worker controls is recorded so the badge's tooltip can name it.
		if (
			(event.clientId || event.resultingClientId) &&
			/^https?:$/.test(url.protocol) &&
			request.mode !== 'navigate' &&
			!(request.cache === 'only-if-cached' && request.mode !== 'same-origin')
		) {
			event.respondWith(
				fetch(request).catch((error) => {
					recordMiss(url)
					throw error
				}),
			)
		}
		return
	}
	if (BYPASS.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + '/')))
		return

	const unserved = () => {
		recordMiss(url)
		return Response.error()
	}

	if (request.mode === 'navigate') {
		event.respondWith(
			networkWithTimeout(request, NAVIGATION_TIMEOUT_MS).then(
				(response) => sameBuildOrOwn(url, response),
				() => ownPage(url).then((page) => page || unserved()),
			),
		)
		return
	}

	if (PRECACHED.has(url.pathname)) {
		event.respondWith(
			fromCache(request).then(
				(cached) =>
					cached ||
					fetch(request).catch((error) => {
						recordMiss(url)
						throw error
					}),
			),
		)
		return
	}

	if (isHashed(url.pathname)) {
		event.respondWith(
			fromCache(request).then(
				(cached) =>
					cached ||
					fetch(request).then(
						(response) => {
							if (response.ok && response.type === 'basic') {
								const copy = response.clone()
								caches.open(CACHE).then((cache) => cache.put(request, copy))
							}
							return response
						},
						(error) => {
							recordMiss(url)
							throw error
						},
					),
			),
		)
		return
	}

	event.respondWith(
		fetch(request).catch(() =>
			fromCache(request).then((cached) => cached || unserved()),
		),
	)
})
`
}

/** Unregisters Kora service workers on the dev origin (dev must never be served a stale shell). */
const DEV_UNREGISTER_SCRIPT = `if ('serviceWorker' in navigator) {
	navigator.serviceWorker.getRegistrations().then((registrations) => {
		for (const registration of registrations) {
			const script = registration.active || registration.waiting || registration.installing
			if (script && /\\/sw\\.js$/.test(new URL(script.scriptURL).pathname)) registration.unregister()
		}
	})
	caches.keys().then((keys) => keys.filter((k) => k.startsWith(${JSON.stringify(SW_CACHE_PREFIX)})).forEach((k) => caches.delete(k)))
}`

/**
 * Registration and update flow, injected into the built `index.html`.
 *
 * @param input - Worker URL, scope and whether to show the built-in prompt
 * @returns Module script source
 */
export function registrationScript(input: {
	swUrl: string
	scope: string
	updatePrompt: boolean
	/** See {@link KoraServiceWorkerOptions.firstDataTimeoutMs}. */
	firstDataTimeoutMs?: number
}): string {
	const firstDataTimeoutMs = input.firstDataTimeoutMs ?? DEFAULT_FIRST_DATA_TIMEOUT_MS
	return `// Kora offline app shell: service worker registration, update flow and shell status.
// The status contract the app reads (korajs cannot import @korajs/cli): globalThis.__KORA_SHELL__ =
// { v: 1, state, version, misses }, updated with a 'kora:shell' window event. Never polled.
const publishShell = (state, version, misses) => {
	const previous = globalThis.__KORA_SHELL__
	if (
		previous &&
		previous.v === 1 &&
		previous.state === state &&
		previous.version === version &&
		JSON.stringify(previous.misses) === JSON.stringify(misses)
	)
		return
	const next = { v: 1, state, version, misses }
	globalThis.__KORA_SHELL__ = next
	window.dispatchEvent(new CustomEvent('kora:shell', { detail: next }))
}
if ('serviceWorker' in navigator && window.isSecureContext && /^https?:$/.test(location.protocol)) {
	const swUrl = ${JSON.stringify(input.swUrl)}
	const scope = ${JSON.stringify(input.scope)}
	const showPrompt = ${JSON.stringify(input.updatePrompt)}
	// An active worker that never answers predates the status protocol (or is stuck): its cache
	// cannot be verified, which is reported as not installed. A late answer still counts.
	const STATUS_TIMEOUT_MS = 15000
	const FIRST_DATA_TIMEOUT_MS = ${JSON.stringify(firstDataTimeoutMs)}
	// After the first data, the precache still waits for an idle moment, at most this long.
	const IDLE_TIMEOUT_MS = 2000
	let accepted = false
	let registerFailed = false
	let asked = 0
	let applied = 0
	publishShell('installing', null, [])

	// Hashed scripts and styles of this page: the worker compares them with its own build.
	const pageAssets = () => {
		const paths = new Set()
		const add = (value) => {
			if (!value) return
			try {
				const url = new URL(value, location.href)
				if (url.origin === location.origin && /\\.(m?js|css)$/.test(url.pathname)) paths.add(url.pathname)
			} catch (error) {
				// Not a URL: nothing to compare.
			}
		}
		for (const entry of performance.getEntriesByType('resource')) add(entry.name)
		for (const script of document.scripts) add(script.src)
		for (const link of document.querySelectorAll('link[rel="stylesheet"], link[rel="modulepreload"]')) add(link.href)
		return [...paths]
	}
	const apply = (reply) => {
		if (!reply || reply.v !== 1) return publishShell('not-installed', null, [])
		const misses = Array.isArray(reply.misses) ? reply.misses.filter((miss) => typeof miss === 'string') : []
		const version = typeof reply.version === 'string' ? reply.version : null
		if (reply.complete !== true) return publishShell('not-installed', version, misses)
		publishShell(reply.sameBuild === false ? 'other-build' : 'installed', version, misses)
	}
	const ask = (worker) => {
		const seq = ++asked
		try {
			const channel = new MessageChannel()
			const timer = setTimeout(() => {
				if (seq === asked) apply(null)
			}, STATUS_TIMEOUT_MS)
			channel.port1.onmessage = (event) => {
				clearTimeout(timer)
				channel.port1.close()
				// An older question answered after a newer one is stale.
				if (seq >= applied) {
					applied = seq
					apply(event.data)
				}
			}
			worker.postMessage({ type: 'KORA_SW_STATUS', pages: pageAssets() }, [channel.port2])
		} catch (error) {
			apply(null)
		}
	}
	const checkShell = async () => {
		let registration
		try {
			registration = await navigator.serviceWorker.getRegistration(scope)
		} catch (error) {
			registration = undefined
		}
		if (!registration) return publishShell(registerFailed ? 'not-installed' : 'installing', null, [])
		// The ACTIVE worker, not the controller: a hard reload leaves the page uncontrolled
		// although offline reloads work.
		if (registration.active) return ask(registration.active)
		if (registration.installing || registration.waiting) return publishShell('installing', null, [])
		publishShell('not-installed', null, [])
	}
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		// Reload only for an update the user accepted, never for the first install's claim.
		if (accepted) location.reload()
		else checkShell()
	})
	const offer = (worker) => {
		// No controller means this is the first install: there is nothing to update.
		if (!navigator.serviceWorker.controller) return
		const update = () => {
			accepted = true
			worker.postMessage({ type: 'KORA_SW_SKIP_WAITING' })
		}
		const event = new CustomEvent('kora:update-available', { detail: { update }, cancelable: true })
		const handled = !window.dispatchEvent(event)
		if (showPrompt && !handled) renderPrompt(update)
	}
	const renderPrompt = (update) => {
		if (document.getElementById('kora-update-prompt')) return
		const bar = document.createElement('div')
		bar.id = 'kora-update-prompt'
		bar.setAttribute('role', 'status')
		bar.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:space-between;max-width:480px;margin:0 auto;padding:12px 16px;border-radius:8px;background:#111;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)'
		const text = document.createElement('span')
		text.textContent = 'A new version is available.'
		const button = document.createElement('button')
		button.type = 'button'
		button.textContent = 'Reload'
		button.style.cssText = 'padding:6px 12px;border:0;border-radius:6px;background:#fff;color:#111;font:inherit;cursor:pointer'
		button.addEventListener('click', () => {
			button.disabled = true
			update()
		})
		bar.append(text, button)
		document.body.append(bar)
	}
	// Checked at start, on updatefound, controllerchange and visibilitychange; never polled.
	checkShell()
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') checkShell()
	})
	// First-visit parity (design section 5.8): installing the worker precaches the whole shell,
	// so on a page no worker controls yet it waits for the app's first data (the
	// 'kora:first-data' event korajs dispatches, mirrored on globalThis.__KORA_FIRST_DATA__),
	// at most FIRST_DATA_TIMEOUT_MS after load, then for an idle moment. A page without a Kora
	// app announcing itself only waits for idle. A page a worker already controls loads from
	// the precache: it registers at load (the update check), as before.
	const firstData = () =>
		new Promise((resolve) => {
			const signal = globalThis.__KORA_FIRST_DATA__
			if (!signal || signal.v !== 1 || signal.state !== 'pending') return resolve()
			let timer = null
			const done = () => {
				window.removeEventListener('kora:first-data', done)
				if (timer !== null) clearTimeout(timer)
				resolve()
			}
			window.addEventListener('kora:first-data', done)
			timer = setTimeout(done, FIRST_DATA_TIMEOUT_MS)
		})
	const idle = () =>
		new Promise((resolve) => {
			if (typeof globalThis.requestIdleCallback === 'function') {
				globalThis.requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS })
			} else {
				// No idle callbacks (Safari): the first data was the signal that mattered.
				resolve()
			}
		})
	window.addEventListener('load', () => {
		const start = navigator.serviceWorker.controller ? Promise.resolve() : firstData().then(idle)
		start.then(() => register())
	})
	const register = () => {
		navigator.serviceWorker
			.register(swUrl, { scope, updateViaCache: 'none' })
			.then((registration) => {
				if (registration.waiting) offer(registration.waiting)
				registration.addEventListener('updatefound', () => {
					const worker = registration.installing
					if (!worker) return
					worker.addEventListener('statechange', () => {
						if (worker.state === 'installed') offer(worker)
						// The first install finishing (or failing) changes the shell's state.
						if (worker.state === 'activated' || worker.state === 'redundant') checkShell()
					})
					checkShell()
				})
				checkShell()
				// Long-lived tabs (kiosks, shared tablets) still learn about new deploys.
				const check = () => registration.update().catch(() => {})
				setInterval(check, 60 * 60 * 1000)
				document.addEventListener('visibilitychange', () => {
					if (document.visibilityState === 'visible') check()
				})
			})
			.catch((error) => {
				registerFailed = true
				checkShell()
				console.warn('[kora] service worker registration failed:', error)
			})
	}
} else {
	publishShell('unsupported', null, [])
}`
}
