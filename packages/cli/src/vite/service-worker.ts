import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

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
 *   activates it and reloads, so old and new assets never mix in one page.
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

/** Cache-name prefix shared by every version, so `activate` can delete old versions. */
export const SW_CACHE_PREFIX = 'kora-shell-'

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
	let config: ResolvedViteConfig | null = null

	return {
		name: 'kora-service-worker',
		enforce: 'post',
		configResolved(resolved) {
			config = resolved
		},
		transformIndexHtml(html) {
			if (!config) return { html, tags: [] }
			const children =
				config.command === 'build'
					? registrationScript({
							swUrl: `${config.base}${fileName}`,
							scope: config.base,
							updatePrompt,
						})
					: DEV_UNREGISTER_SCRIPT
			return {
				html,
				tags: [{ tag: 'script', attrs: { type: 'module' }, children, injectTo: 'body' }],
			}
		},
		closeBundle: {
			order: 'post',
			sequential: true,
			handler() {
				if (!config || config.command !== 'build') return
				const outDir = resolve(config.root, config.build.outDir)
				if (!existsSync(join(outDir, 'index.html'))) return
				const { urls, version } = collectPrecache(outDir, config.base, fileName)
				writeFileSync(
					join(outDir, fileName),
					serviceWorkerSource({
						version,
						precache: urls,
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
 * directories (`.vite/`), and an unhashed copy whose bytes equal a content-hashed file
 * (the templates copy `sqlite3-<hash>.wasm` to `sqlite3.wasm`; precaching both would
 * double a ~1 MB first download on the slow links Kora targets).
 *
 * @param outDir - Absolute build directory
 * @param base - Vite `base` (URL prefix ending in `/`)
 * @param swFileName - The worker's own file name, excluded from the list
 * @returns Precache URLs (sorted) and a 16-hex-digit content version
 */
export function collectPrecache(
	outDir: string,
	base: string,
	swFileName = 'sw.js',
): { urls: string[]; version: string } {
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
			if (rel === swFileName || /\.(map|br|gz)$/.test(rel)) continue
			files.push({
				path: rel,
				digest: createHash('sha256').update(readFileSync(full)).digest('hex'),
			})
		}
	}
	walk(outDir)

	const hashedDigests = new Set(files.filter((f) => isHashedName(f.path)).map((f) => f.digest))
	const kept = files
		.filter((f) => isHashedName(f.path) || !hashedDigests.has(f.digest))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

	const version = createHash('sha256')
	for (const f of kept) version.update(`${f.path}\0${f.digest}\n`)
	return {
		urls: kept.map((f) => `${base}${f.path}`),
		version: version.digest('hex').slice(0, 16),
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
	shellUrl: string
	bypass: string[]
	navigationTimeoutMs: number
}

/**
 * Source of the generated service worker.
 *
 * - install: precache every shell file into `kora-shell-<version>` (bypassing the HTTP
 *   cache). It does NOT skip waiting: an update waits for the page to accept it.
 * - activate: delete every other `kora-shell-*` cache, then claim clients.
 * - fetch (same-origin GET only, bypass prefixes untouched):
 *   - navigations: network first (with a timeout), falling back to the cached shell;
 *   - content-hashed files: cache first (their bytes can never change);
 *   - everything else: network first, falling back to the cache. Never cache first:
 *     an unhashed `sqlite3.wasm` from the old cache next to new JavaScript would not open.
 */
export function serviceWorkerSource(input: WorkerSourceInput): string {
	return `// Generated by @korajs/cli koraServiceWorker(). Do not edit: rebuilt on every \`vite build\`.
const VERSION = ${JSON.stringify(input.version)}
const CACHE = ${JSON.stringify(SW_CACHE_PREFIX)} + VERSION
const PRECACHE = ${JSON.stringify(input.precache)}
const SHELL = ${JSON.stringify(input.shellUrl)}
const BYPASS = ${JSON.stringify(input.bypass)}
const NAVIGATION_TIMEOUT_MS = ${JSON.stringify(input.navigationTimeoutMs)}

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE).then((cache) =>
			cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))),
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

self.addEventListener('message', (event) => {
	if (event.data && event.data.type === 'KORA_SW_SKIP_WAITING') self.skipWaiting()
})

function isHashed(pathname) {
	const name = pathname.slice(pathname.lastIndexOf('/') + 1)
	const match = /[.-]([A-Za-z0-9_]{8,})\\.[A-Za-z0-9]+$/.exec(name)
	return match !== null && /[A-Z0-9]/.test(match[1])
}

function fromCache(request) {
	return caches.open(CACHE).then((cache) => cache.match(request, { ignoreSearch: true }))
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
	if (url.origin !== self.location.origin) return
	if (BYPASS.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + '/')))
		return

	if (request.mode === 'navigate') {
		event.respondWith(
			networkWithTimeout(request, NAVIGATION_TIMEOUT_MS).catch(() =>
				caches
					.open(CACHE)
					.then((cache) => cache.match(SHELL))
					.then((shell) => shell || Response.error()),
			),
		)
		return
	}

	if (isHashed(url.pathname)) {
		event.respondWith(
			fromCache(request).then(
				(cached) =>
					cached ||
					fetch(request).then((response) => {
						if (response.ok && response.type === 'basic') {
							const copy = response.clone()
							caches.open(CACHE).then((cache) => cache.put(request, copy))
						}
						return response
					}),
			),
		)
		return
	}

	event.respondWith(
		fetch(request).catch(() =>
			fromCache(request).then((cached) => cached || Response.error()),
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
}): string {
	return `// Kora offline app shell: service worker registration and update flow.
if ('serviceWorker' in navigator && window.isSecureContext && /^https?:$/.test(location.protocol)) {
	const swUrl = ${JSON.stringify(input.swUrl)}
	const showPrompt = ${JSON.stringify(input.updatePrompt)}
	let accepted = false
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		// Reload only for an update the user accepted, never for the first install's claim.
		if (accepted) location.reload()
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
	window.addEventListener('load', () => {
		navigator.serviceWorker
			.register(swUrl, { scope: ${JSON.stringify(input.scope)}, updateViaCache: 'none' })
			.then((registration) => {
				if (registration.waiting) offer(registration.waiting)
				registration.addEventListener('updatefound', () => {
					const worker = registration.installing
					if (!worker) return
					worker.addEventListener('statechange', () => {
						if (worker.state === 'installed') offer(worker)
					})
				})
				// Long-lived tabs (kiosks, shared tablets) still learn about new deploys.
				const check = () => registration.update().catch(() => {})
				setInterval(check, 60 * 60 * 1000)
				document.addEventListener('visibilitychange', () => {
					if (document.visibilityState === 'visible') check()
				})
			})
			.catch((error) => console.warn('[kora] service worker registration failed:', error))
	})
}`
}
