import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
	DEFAULT_SW_BYPASS,
	collectPrecache,
	isHashedName,
	koraServiceWorker,
	registrationScript,
	serviceWorkerSource,
} from './service-worker'

const here = dirname(fileURLToPath(import.meta.url))
const templatesDir = resolve(here, '../../templates')

let dirs: string[] = []
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
	dirs = []
})

function buildDir(files: Record<string, string | Buffer>): string {
	const dir = mkdtempSync(join(tmpdir(), 'kora-sw-'))
	dirs.push(dir)
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true })
		writeFileSync(join(dir, path), content)
	}
	return dir
}

describe('isHashedName', () => {
	test.each([
		['assets/index-DrBNyszg.js', true],
		['assets/sqlite3-Ab12Cd34.wasm', true],
		['assets/sqlite3.wasm', false],
		['assets/sqlite3-opfs-async-proxy.js', false],
		['index.html', false],
		['favicon.ico', false],
	])('%s -> %s', (path, hashed) => {
		expect(isHashedName(path)).toBe(hashed)
	})
})

describe('collectPrecache', () => {
	const wasm = Buffer.alloc(2048, 7)

	test('lists the shell, skips maps, compressed siblings, dot dirs and the worker', () => {
		const dir = buildDir({
			'index.html': '<html></html>',
			'sw.js': 'old worker',
			'manifest.webmanifest': '{}',
			'assets/index-DrBNyszg.js': 'js',
			'assets/index-DrBNyszg.js.map': '{}',
			'assets/index-DrBNyszg.js.br': 'br',
			'assets/index-Ab12Cd34.css': 'css',
			'.vite/manifest.json': '{}',
		})
		expect(collectPrecache(dir, '/').urls).toEqual([
			'/assets/index-Ab12Cd34.css',
			'/assets/index-DrBNyszg.js',
			'/index.html',
			'/manifest.webmanifest',
		])
	})

	test('lazy files are left out of the precache but still change the version', () => {
		const files = {
			'index.html': '<html></html>',
			'guide/index.html': '<html>guide</html>',
			'guide/img/a.jpg': 'a1',
		}
		const before = collectPrecache(buildDir(files), '/', 'sw.js', ['/guide/img'])
		expect(before.urls).toEqual(['/guide/index.html', '/index.html'])
		expect(before.digests['/guide/img/a.jpg']).toBeUndefined()
		expect(before.lazyDigests).toEqual({
			'/guide/img/a.jpg': createHash('sha256').update('a1').digest('hex'),
		})
		const after = collectPrecache(buildDir({ ...files, 'guide/img/a.jpg': 'a2' }), '/', 'sw.js', [
			'/guide/img',
		])
		expect(after.version).not.toBe(before.version)
		// The prefix is a path segment: /guide/imgs is not under /guide/img.
		expect(
			collectPrecache(buildDir({ ...files, 'guide/imgs/b.jpg': 'b' }), '/', 'sw.js', ['/guide/img'])
				.urls,
		).toContain('/guide/imgs/b.jpg')
	})

	test('byte-identical files are all precached, the shortest URL fetched for the others', () => {
		// The templates copy the hashed WASM to sqlite3.wasm, the name the SQLite runtime
		// fetches; Vite's hash may contain '-' (sqlite3-1f8bVu-G.wasm), which isHashedName does
		// not recognise, so grouping is by content, not by name.
		const dir = buildDir({
			'index.html': '<html></html>',
			'assets/sqlite3-1f8bVu-G.wasm': wasm,
			'assets/sqlite3.wasm': wasm,
			'assets/sqlite3-opfs-async-proxy.js': 'proxy',
		})
		const result = collectPrecache(dir, '/app/')
		// Every URL stays in the precache: each must open offline.
		expect(result.urls).toEqual([
			'/app/assets/sqlite3-1f8bVu-G.wasm',
			'/app/assets/sqlite3-opfs-async-proxy.js',
			'/app/assets/sqlite3.wasm',
			'/app/index.html',
		])
		expect(result.aliases).toEqual({
			'/app/assets/sqlite3-1f8bVu-G.wasm': '/app/assets/sqlite3.wasm',
		})
	})

	test('no aliases when every file is distinct', () => {
		const dir = buildDir({ 'index.html': 'a', 'assets/x-Ab12Cd34.js': '1' })
		expect(collectPrecache(dir, '/').aliases).toEqual({})
	})

	test('the built worker carries the aliases', () => {
		const dir = buildDir({
			'dist/index.html': '<html></html>',
			'dist/assets/sqlite3-Ab12Cd34.wasm': wasm,
			'dist/assets/sqlite3.wasm': wasm,
		})
		const plugin = koraServiceWorker()
		plugin.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: 'dist' } })
		plugin.closeBundle.handler()
		const sw = readFileSync(join(dir, 'dist/sw.js'), 'utf8')
		expect(sw).toContain('const ALIASES = {"/assets/sqlite3-Ab12Cd34.wasm":"/assets/sqlite3.wasm"}')
	})

	test('the version changes with any precached byte and only then', () => {
		const a = buildDir({ 'index.html': 'a', 'assets/x-Ab12Cd34.js': '1' })
		const b = buildDir({ 'index.html': 'a', 'assets/x-Ab12Cd34.js': '1', 'x.map': 'ignored' })
		const c = buildDir({ 'index.html': 'b', 'assets/x-Ab12Cd34.js': '1' })
		expect(collectPrecache(a, '/').version).toBe(collectPrecache(b, '/').version)
		expect(collectPrecache(a, '/').version).not.toBe(collectPrecache(c, '/').version)
		expect(collectPrecache(a, '/').version).toMatch(/^[0-9a-f]{16}$/)
	})
})

describe('collectPrecache digests', () => {
	test('records the SHA-256 of every precached file by URL, and the worker embeds them', () => {
		const dir = buildDir({ 'index.html': 'page', 'assets/x-Ab12Cd34.js': 'code' })
		const { urls, digests } = collectPrecache(dir, '/app/')
		const sha = (body: string) => createHash('sha256').update(body).digest('hex')
		expect(Object.keys(digests)).toEqual(urls)
		expect(digests['/app/index.html']).toBe(sha('page'))
		expect(digests['/app/assets/x-Ab12Cd34.js']).toBe(sha('code'))
	})

	test('the built worker carries DIGESTS for its PRECACHE', () => {
		const dir = buildDir({ 'dist/index.html': '<html></html>', 'dist/assets/a-Ab12Cd34.js': 'x' })
		const plugin = koraServiceWorker()
		plugin.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: 'dist' } })
		plugin.closeBundle.handler()
		const sw = readFileSync(join(dir, 'dist/sw.js'), 'utf8')
		const digest = createHash('sha256').update('x').digest('hex')
		expect(sw).toContain(`"/assets/a-Ab12Cd34.js":"${digest}"`)
	})
})

describe('serviceWorkerSource', () => {
	const source = serviceWorkerSource({
		version: 'abc',
		precache: ['/index.html'],
		shellUrl: '/index.html',
		bypass: [...DEFAULT_SW_BYPASS],
		navigationTimeoutMs: 4000,
	})

	test('is valid JavaScript', () => {
		expect(() => new Function(source)).not.toThrow()
	})

	test('never handles the sync endpoint or auth routes, and waits for the page to accept updates', () => {
		expect(source).toContain('"/kora-sync"')
		expect(source).toContain('"/auth"')
		expect(source).toContain("'KORA_SW_SKIP_WAITING'")
		// skipWaiting only on the page's message, never during install.
		const install = source.slice(source.indexOf("'install'"), source.indexOf("'activate'"))
		expect(install).not.toContain('skipWaiting')
	})
})

describe('registrationScript', () => {
	test('is valid JavaScript and registers with the base scope', () => {
		const script = registrationScript({ swUrl: '/app/sw.js', scope: '/app/', updatePrompt: true })
		expect(() => new Function(script)).not.toThrow()
		expect(script).toContain('"/app/sw.js"')
		expect(script).toContain('kora:update-available')
	})
})

describe('koraServiceWorker plugin', () => {
	test('a failed build with no output directory keeps its original error visible', () => {
		const dir = buildDir({})
		const plugin = koraServiceWorker()
		plugin.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: 'missing' } })
		expect(() => plugin.closeBundle.handler()).not.toThrow()
	})

	test('build: injects registration and writes sw.js after the bundle', () => {
		const dir = buildDir({ 'dist/index.html': '<html></html>', 'dist/assets/a-Ab12Cd34.js': 'x' })
		const plugin = koraServiceWorker()
		plugin.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: 'dist' } })
		const { tags } = plugin.transformIndexHtml('<html></html>')
		expect(tags[0]?.children).toContain('register(')
		plugin.closeBundle.handler()
		const sw = readFileSync(join(dir, 'dist/sw.js'), 'utf8')
		expect(sw).toContain('/assets/a-Ab12Cd34.js')
		expect(sw).not.toContain('"/sw.js"')
	})

	test('dev: never registers, unregisters stale Kora workers instead', () => {
		const plugin = koraServiceWorker()
		plugin.configResolved({ root: '/x', base: '/', command: 'serve', build: { outDir: 'dist' } })
		const { tags } = plugin.transformIndexHtml('<html></html>')
		expect(tags[0]?.children).not.toContain('.register(')
		expect(tags[0]?.children).toContain('unregister()')
	})
})

describe('bundled templates', () => {
	const templates = readdirSync(templatesDir)

	test.each(templates.filter((t) => t !== 'tauri-react'))(
		'%s enables the offline app shell',
		(template) => {
			const config = readFileSync(join(templatesDir, template, 'vite.config.ts'), 'utf8')
			expect(config).toContain("import { koraServiceWorker } from '@korajs/cli/vite'")
			// Last in the plugin list, so it runs after the sqlite WASM copy step.
			expect(config).toMatch(/plugins: \[[^\]]*koraServiceWorker\(\),?\s*\]/)
			const manifest = readFileSync(join(templatesDir, template, 'package.json.hbs'), 'utf8')
			expect(manifest).toContain('"@korajs/cli"')
		},
	)

	test('tauri-react embeds its frontend in the binary (offline by construction, no worker)', () => {
		const config = readFileSync(join(templatesDir, 'tauri-react', 'vite.config.ts'), 'utf8')
		expect(config).not.toContain('koraServiceWorker')
	})
})

/**
 * The generated worker run in a minimal ServiceWorkerGlobalScope: one build per active
 * worker (RT-109).
 */
describe('generated worker: one build per active worker (RT-109)', () => {
	const sha = (body: string) => createHash('sha256').update(body).digest('hex')
	interface FakeResponse {
		ok: boolean
		type: string
		body: string
		headers: { get(name: string): string | null }
		redirected: boolean
		text(): Promise<string>
		arrayBuffer(): Promise<ArrayBuffer>
		clone(): FakeResponse
	}
	const respond = (body: string, contentType: string): FakeResponse => ({
		ok: true,
		type: 'basic',
		body,
		headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
		redirected: false,
		text: async () => body,
		arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
		clone: () => respond(body, contentType),
	})
	const typeOf = (path: string): string =>
		path.endsWith('.html') || !path.includes('.') ? 'text/html' : 'application/octet-stream'
	const page = (build: string, name = 'index') =>
		`<html><head><meta name="kora-shell" content="1"></head>${name} ${build}</html>`

	function worker(
		precached: Record<string, string>,
		initialNetwork: Record<string, string> | null,
		lazy: Record<string, string> = {},
	) {
		let network = initialNetwork
		type Handler = (event: unknown) => void
		const handlers = new Map<string, Handler>()
		const cache = new Map<string, string>()
		const cacheApi = {
			match: async (req: string | { url: string }) => {
				const path = typeof req === 'string' ? req : new URL(req.url).pathname
				const body = cache.get(path)
				return body === undefined ? undefined : respond(body, typeOf(path))
			},
			put: async (req: string | { url: string }, response: FakeResponse) => {
				const path = typeof req === 'string' ? req : new URL(req.url).pathname
				cache.set(path, await response.text())
			},
		}
		// The install downloads the build being installed; afterwards `network` is what the
		// server serves (a newer deploy, or nothing).
		let installing = false
		const source = serviceWorkerSource({
			version: 'v1',
			precache: Object.keys(precached),
			shellUrl: '/index.html',
			bypass: [...DEFAULT_SW_BYPASS],
			lazy,
			navigationTimeoutMs: 4000,
		})
		const fetchFn = async (req: { url: string }) => {
			const path = new URL(req.url).pathname
			const body = installing ? precached[path] : network?.[path]
			if ((!installing && network === null) || body === undefined) {
				throw new TypeError('Failed to fetch')
			}
			return respond(body, typeOf(path))
		}
		class FakeRequest {
			url: string
			constructor(url: string) {
				this.url = new URL(url, 'https://app.test').href
			}
		}
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
			{ error: () => respond('', 'error') },
		)
		return {
			/** What the server serves from now on (null: offline). */
			setNetwork(next: Record<string, string> | null): void {
				network = next
			},
			async install(): Promise<void> {
				let done: unknown = undefined
				installing = true
				handlers.get('install')?.({
					waitUntil: (p: Promise<unknown>) => {
						done = p
					},
				})
				try {
					await done
				} finally {
					installing = false
				}
			},
			async get(path: string, mode: 'navigate' | 'no-cors' = 'no-cors'): Promise<string> {
				let result: Promise<FakeResponse | undefined> = Promise.resolve(undefined)
				const extended: Promise<unknown>[] = []
				handlers.get('fetch')?.({
					request: { method: 'GET', mode, url: `https://app.test${path}` },
					respondWith: (p: Promise<FakeResponse>) => {
						result = p
					},
					waitUntil: (p: Promise<unknown>) => {
						extended.push(p)
					},
				})
				const body = (await result)?.body ?? '<not handled>'
				await Promise.all(extended)
				return body
			},
		}
	}

	const v1Files = {
		'/index.html': page('v1'),
		'/admin.html': page('v1', 'admin'),
		'/assets/sqlite3.wasm': 'wasm v1',
		'/assets/app-Ab12Cd34.js': 'js v1',
	}

	test('after a newer deploy, navigations and build files stay this build, online and offline', async () => {
		const sw = worker(v1Files, {
			'/': page('v2'),
			'/index.html': page('v2'),
			'/todos/42': page('v2'),
			'/admin.html': page('v2', 'admin'),
			'/assets/sqlite3.wasm': 'wasm v2',
		})
		await sw.install()
		expect(await sw.get('/', 'navigate')).toBe(page('v1'))
		expect(await sw.get('/todos/42', 'navigate')).toBe(page('v1'))
		expect(await sw.get('/admin.html', 'navigate')).toBe(page('v1', 'admin'))
		// The unhashed files of the build are this build's bytes too.
		expect(await sw.get('/assets/sqlite3.wasm')).toBe('wasm v1')
		const offline = worker(v1Files, null)
		await offline.install()
		expect(await offline.get('/', 'navigate')).toBe(page('v1'))
		expect(await offline.get('/admin.html', 'navigate')).toBe(page('v1', 'admin'))
	})

	test('the same build, server-rendered pages and non-HTML navigations come from the network', async () => {
		const sw = worker(v1Files, {
			'/': page('v1'),
			'/report': '<html>server-rendered report</html>',
			'/export.csv': 'a,b',
			'/api/items': '[]',
		})
		await sw.install()
		expect(await sw.get('/', 'navigate')).toBe(page('v1'))
		expect(await sw.get('/report', 'navigate')).toBe('<html>server-rendered report</html>')
		expect(await sw.get('/export.csv', 'navigate')).toBe('a,b')
		expect(await sw.get('/api/items')).toBe('[]')
	})

	test('a lazy file is cached the first time it is fetched, then served offline', async () => {
		const lazy = { '/guide/img/till.jpg': sha('picture v1'), '/guide/img/other.jpg': sha('other') }
		const sw = worker(v1Files, { '/guide/img/till.jpg': 'picture v1' }, lazy)
		await sw.install()
		expect(await sw.get('/guide/img/till.jpg')).toBe('picture v1')
		sw.setNetwork(null)
		expect(await sw.get('/guide/img/till.jpg')).toBe('picture v1')
		// Never fetched before: not there offline (it was never downloaded).
		await expect(sw.get('/guide/img/other.jpg')).rejects.toThrow('Failed to fetch')
	})

	test("a lazy file's newer-deploy bytes are served but never stored in this version", async () => {
		const lazy = { '/guide/img/till.jpg': sha('picture v1') }
		const sw = worker(v1Files, { '/guide/img/till.jpg': 'picture v2' }, lazy)
		await sw.install()
		expect(await sw.get('/guide/img/till.jpg')).toBe('picture v2')
		sw.setNetwork(null)
		await expect(sw.get('/guide/img/till.jpg')).rejects.toThrow('Failed to fetch')
	})

	test('a file under a lazy folder that the build does not have is not cached', async () => {
		const lazy = { '/guide/img/till.jpg': sha('picture v1') }
		const sw = worker(v1Files, { '/guide/img/new.jpg': 'not this build' }, lazy)
		await sw.install()
		expect(await sw.get('/guide/img/new.jpg')).toBe('not this build')
		sw.setNetwork(null)
		// Network first like any other request, with nothing cached to fall back on.
		expect(await sw.get('/guide/img/new.jpg')).toBe('')
	})

	test("offline, a folder path opens the folder's precached index.html, not the app", async () => {
		// A static page shipped with the app (public/help/index.html): it carries no shell marker.
		const files = { ...v1Files, '/help/index.html': '<html>help</html>' }
		const offline = worker(files, null)
		await offline.install()
		expect(await offline.get('/help/', 'navigate')).toBe('<html>help</html>')
		expect(await offline.get('/help/index.html', 'navigate')).toBe('<html>help</html>')
		// A folder with no page of its own is a client-side route: the app shell.
		expect(await offline.get('/todos/', 'navigate')).toBe(page('v1'))
		expect(await offline.get('/', 'navigate')).toBe(page('v1'))
	})

	test('the plugin marks built pages (not dev pages) for the worker', () => {
		const plugin = koraServiceWorker()
		plugin.configResolved({ root: '/x', base: '/', command: 'build', build: { outDir: 'dist' } })
		expect(plugin.transformIndexHtml('<html></html>').tags).toContainEqual(
			expect.objectContaining({ tag: 'meta', attrs: { name: 'kora-shell', content: '1' } }),
		)
		const dev = koraServiceWorker()
		dev.configResolved({ root: '/x', base: '/', command: 'serve', build: { outDir: 'dist' } })
		expect(
			dev
				.transformIndexHtml('<html></html>')
				.tags.some((tag) => tag.tag === 'meta' && tag.attrs?.name === 'kora-shell'),
		).toBe(false)
	})
})
