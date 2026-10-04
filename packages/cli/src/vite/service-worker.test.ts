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

	test('an unhashed copy of a hashed file is not precached twice', () => {
		const dir = buildDir({
			'index.html': '<html></html>',
			'assets/sqlite3-Ab12Cd34.wasm': wasm,
			'assets/sqlite3.wasm': wasm,
			'assets/sqlite3-opfs-async-proxy.js': 'proxy',
		})
		expect(collectPrecache(dir, '/app/').urls).toEqual([
			'/app/assets/sqlite3-Ab12Cd34.wasm',
			'/app/assets/sqlite3-opfs-async-proxy.js',
			'/app/index.html',
		])
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
	interface FakeResponse {
		ok: boolean
		type: string
		body: string
		headers: { get(name: string): string | null }
		text(): Promise<string>
		clone(): FakeResponse
	}
	const respond = (body: string, contentType: string): FakeResponse => ({
		ok: true,
		type: 'basic',
		body,
		headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
		text: async () => body,
		clone: () => respond(body, contentType),
	})
	const typeOf = (path: string): string =>
		path.endsWith('.html') || !path.includes('.') ? 'text/html' : 'application/octet-stream'
	const page = (build: string, name = 'index') =>
		`<html><head><meta name="kora-shell" content="1"></head>${name} ${build}</html>`

	function worker(precached: Record<string, string>, network: Record<string, string> | null) {
		type Handler = (event: unknown) => void
		const handlers = new Map<string, Handler>()
		const cache = new Map<string, string>()
		const cacheApi = {
			match: async (req: string | { url: string }) => {
				const path = typeof req === 'string' ? req : new URL(req.url).pathname
				const body = cache.get(path)
				return body === undefined ? undefined : respond(body, typeOf(path))
			},
			put: async () => undefined,
			addAll: async (requests: Array<{ url: string }>) => {
				for (const r of requests) {
					const path = new URL(r.url).pathname
					cache.set(path, precached[path] ?? '')
				}
			},
		}
		const source = serviceWorkerSource({
			version: 'v1',
			precache: Object.keys(precached),
			shellUrl: '/index.html',
			bypass: [...DEFAULT_SW_BYPASS],
			navigationTimeoutMs: 4000,
		})
		const fetchFn = async (req: { url: string }) => {
			const path = new URL(req.url).pathname
			const body = network?.[path]
			if (network === null || body === undefined) throw new TypeError('Failed to fetch')
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
			async install(): Promise<void> {
				let done: unknown = undefined
				handlers.get('install')?.({
					waitUntil: (p: Promise<unknown>) => {
						done = p
					},
				})
				await done
			},
			async get(path: string, mode: 'navigate' | 'no-cors' = 'no-cors'): Promise<string> {
				let result: Promise<FakeResponse | undefined> = Promise.resolve(undefined)
				handlers.get('fetch')?.({
					request: { method: 'GET', mode, url: `https://app.test${path}` },
					respondWith: (p: Promise<FakeResponse>) => {
						result = p
					},
				})
				return (await result)?.body ?? '<not handled>'
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

	test('the plugin marks built pages (not dev pages) for the worker', () => {
		const plugin = koraServiceWorker()
		plugin.configResolved({ root: '/x', base: '/', command: 'build', build: { outDir: 'dist' } })
		expect(plugin.transformIndexHtml('<html></html>').tags).toContainEqual(
			expect.objectContaining({ tag: 'meta', attrs: { name: 'kora-shell', content: '1' } }),
		)
		const dev = koraServiceWorker()
		dev.configResolved({ root: '/x', base: '/', command: 'serve', build: { outDir: 'dist' } })
		expect(dev.transformIndexHtml('<html></html>').tags.some((tag) => tag.tag === 'meta')).toBe(
			false,
		)
	})
})
