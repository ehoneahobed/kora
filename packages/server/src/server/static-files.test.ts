import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { type Server, createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	cacheControlFor,
	createStaticFileHandler,
	isContentHashedFileName,
	negotiateEncoding,
} from './static-files'

describe('isContentHashedFileName', () => {
	test.each([
		['index-DrBNyszg.js', true],
		['vendor.B1c2d3e4.css', true],
		['logo-a1b2c3d4.svg', true],
		['sqlite3.wasm', false],
		['sqlite3-opfs-async-proxy.js', false],
		['my-accounts.js', false],
		['index.html', false],
		['sw.js', false],
		['manifest.webmanifest', false],
		['favicon.ico', false],
	])('%s -> %s', (name, hashed) => {
		expect(isContentHashedFileName(name)).toBe(hashed)
		expect(cacheControlFor(name)).toMatch(hashed ? /immutable/ : /^no-cache$/)
	})
})

describe('negotiateEncoding', () => {
	test.each([
		[undefined, null],
		['', null],
		['gzip, deflate, br', 'br'],
		['gzip', 'gzip'],
		['br;q=0, gzip', 'gzip'],
		['identity', null],
		['*', 'br'],
		['*;q=0', null],
	])('%s -> %s', (header, expected) => {
		expect(negotiateEncoding(header)).toBe(expected)
	})
})

describe('createStaticFileHandler', () => {
	let dir: string
	let server: Server
	let base: string
	const big = 'console.log("kora");\n'.repeat(400)

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-static-'))
		mkdirSync(join(dir, 'assets'))
		mkdirSync(join(dir, 'docs'))
		writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>shell</h1>')
		writeFileSync(join(dir, 'docs', 'index.html'), '<h1>docs</h1>')
		writeFileSync(join(dir, 'assets', 'app-AbCd1234.js'), big)
		writeFileSync(join(dir, 'assets', 'pre-AbCd1234.js'), big)
		writeFileSync(join(dir, 'assets', 'pre-AbCd1234.js.gz'), gzipSync(big, { level: 1 }))
		writeFileSync(join(dir, 'assets', 'stale-AbCd1234.js'), big)
		// A sibling left over from another build: it does not decompress to the file.
		writeFileSync(join(dir, 'assets', 'stale-AbCd1234.js.gz'), gzipSync('PRECOMPRESSED'))
		writeFileSync(join(dir, 'secret.txt'), 'outside?')
		const old = new Date('2026-01-01T00:00:00Z')
		utimesSync(join(dir, 'index.html'), old, old)
		const handle = createStaticFileHandler(dir)
		server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://x')
			void handle(req, res, url.pathname)
		})
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})
	afterAll(async () => {
		await new Promise<void>((done) => server.close(() => done()))
		rmSync(dir, { recursive: true, force: true })
	})

	test('a navigation to an unknown route gets the SPA shell', async () => {
		const r = await fetch(`${base}/todos/42`, { headers: { accept: 'text/html' } })
		expect(r.status).toBe(200)
		expect(await r.text()).toContain('shell')
		expect(r.headers.get('cache-control')).toBe('no-cache')
	})

	test('a non-navigation request for a missing path is a 404', async () => {
		expect((await fetch(`${base}/todos/42`, { headers: { accept: '*/*' } })).status).toBe(404)
		expect((await fetch(`${base}/missing.js`)).status).toBe(404)
	})

	test('a navigation under /assets/ never gets the shell', async () => {
		const r = await fetch(`${base}/assets/gone-AbCd9999.js`, { headers: { accept: 'text/html' } })
		expect(r.status).toBe(404)
	})

	test('a directory with an index.html serves it', async () => {
		expect(await (await fetch(`${base}/docs/`)).text()).toContain('docs')
	})

	test('paths cannot escape the static directory', async () => {
		for (const path of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/%00']) {
			const r = await fetch(`${base}${path}`)
			expect(r.status).toBe(404)
		}
	})

	test('If-Modified-Since yields 304 for content-hashed files only (RT-99)', async () => {
		const r = await fetch(`${base}/assets/app-AbCd1234.js`)
		const lm = r.headers.get('last-modified') ?? ''
		expect(lm).not.toBe('')
		const r2 = await fetch(`${base}/assets/app-AbCd1234.js`, {
			headers: { 'if-modified-since': lm },
		})
		expect(r2.status).toBe(304)
		// A revalidated file's mtime is not a validator: no Last-Modified, and
		// If-Modified-Since alone never yields 304.
		const shell = await fetch(`${base}/`)
		expect(shell.headers.get('last-modified')).toBeNull()
		const shell2 = await fetch(`${base}/`, {
			headers: { 'if-modified-since': new Date('2030-01-01T00:00:00Z').toUTCString() },
		})
		expect(shell2.status).toBe(200)
	})

	test('ETags are content digests: If-None-Match with the same ETag yields 304', async () => {
		const r = await fetch(`${base}/`)
		const etag = r.headers.get('etag') ?? ''
		expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/)
		const r2 = await fetch(`${base}/`, { headers: { 'if-none-match': etag } })
		expect(r2.status).toBe(304)
	})

	test('a stale ETag gets the full body', async () => {
		const r = await fetch(`${base}/`, { headers: { 'if-none-match': '"nope"' } })
		expect(r.status).toBe(200)
	})

	test('compressed and identity representations have distinct ETags', async () => {
		const gz = await fetch(`${base}/assets/app-AbCd1234.js`, {
			headers: { 'accept-encoding': 'gzip' },
		})
		const id = await fetch(`${base}/assets/app-AbCd1234.js`, {
			headers: { 'accept-encoding': 'identity' },
		})
		expect(gz.headers.get('content-encoding')).toBe('gzip')
		expect(id.headers.get('content-encoding')).toBeNull()
		expect(gz.headers.get('etag')).not.toBe(id.headers.get('etag'))
		expect(await gz.text()).toBe(big)
		expect(await id.text()).toBe(big)
	})

	test('a pre-compressed sibling is served when it holds the file', async () => {
		const r = await fetch(`${base}/assets/pre-AbCd1234.js`, {
			headers: { 'accept-encoding': 'gzip' },
		})
		expect(Number(r.headers.get('content-length'))).toBe(gzipSync(big, { level: 1 }).length)
		expect(await r.text()).toBe(big)
	})

	test('a pre-compressed sibling of other content is ignored (RT-99)', async () => {
		const r = await fetch(`${base}/assets/stale-AbCd1234.js`, {
			headers: { 'accept-encoding': 'gzip' },
		})
		expect(r.headers.get('content-encoding')).toBe('gzip')
		expect(await r.text()).toBe(big)
	})

	test('HEAD sends headers only, other methods are refused', async () => {
		const head = await fetch(`${base}/assets/app-AbCd1234.js`, { method: 'HEAD' })
		expect(head.status).toBe(200)
		expect(await head.text()).toBe('')
		const post = await fetch(`${base}/index.html`, { method: 'POST' })
		expect(post.status).toBe(405)
		expect(post.headers.get('allow')).toBe('GET, HEAD')
	})
})

describe("spaFallback: 'extensionless' (F7)", () => {
	let dir: string
	let server: Server
	let base: string

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-static-spa-'))
		mkdirSync(join(dir, 'assets'))
		writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>shell</h1>')
		const handle = createStaticFileHandler(dir, { spaFallback: 'extensionless' })
		server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://x')
			void handle(req, res, url.pathname)
		})
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})
	afterAll(async () => {
		await new Promise<void>((done) => server.close(() => done()))
		rmSync(dir, { recursive: true, force: true })
	})

	test('a service worker warming an app route (Accept: */*) gets the shell', async () => {
		const r = await fetch(`${base}/f/some-form`, { headers: { accept: '*/*' } })
		expect(r.status).toBe(200)
		expect(await r.text()).toContain('shell')
	})

	test('missing files and assets are still 404', async () => {
		expect((await fetch(`${base}/missing.js`, { headers: { accept: '*/*' } })).status).toBe(404)
		expect((await fetch(`${base}/assets/chunk`, { headers: { accept: '*/*' } })).status).toBe(404)
	})
})

describe('redeploys with normalised mtimes (RT-99)', () => {
	const fixed = new Date('1980-01-01T00:00:00Z')

	function build(root: string, hash: string): void {
		mkdirSync(join(root, 'assets'), { recursive: true })
		// Same length in every build: only the referenced chunk hash differs.
		writeFileSync(join(root, 'index.html'), `<script src="/assets/index-${hash}.js"></script>`)
		writeFileSync(join(root, 'sw.js'), `const VERSION = "${hash}${hash}"\n`)
		for (const name of ['index.html', 'sw.js']) utimesSync(join(root, name), fixed, fixed)
	}

	async function serveOnce(root: string, run: (base: string) => Promise<void>): Promise<void> {
		const handle = createStaticFileHandler(root)
		const srv = createServer((req, res) => {
			void handle(req, res, new URL(req.url ?? '/', 'http://x').pathname)
		})
		await new Promise<void>((done) => srv.listen(0, '127.0.0.1', () => done()))
		try {
			await run(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)
		} finally {
			await new Promise<void>((done) => srv.close(() => done()))
		}
	}

	test('a new build directory served by a restarted server is never 304', async () => {
		const parent = mkdtempSync(join(tmpdir(), 'kora-redeploy-'))
		const v1 = join(parent, 'v1')
		const v2 = join(parent, 'v2')
		build(v1, 'AAAAAAAA')
		build(v2, 'BBBBBBBB')
		const etags: Record<string, string> = {}
		await serveOnce(v1, async (base) => {
			for (const name of ['index.html', 'sw.js']) {
				etags[name] = (await fetch(`${base}/${name}`)).headers.get('etag') ?? ''
			}
		})
		await serveOnce(v2, async (base) => {
			for (const name of ['index.html', 'sw.js']) {
				const r = await fetch(`${base}/${name}`, {
					headers: {
						'if-none-match': etags[name] ?? '',
						'if-modified-since': fixed.toUTCString(),
					},
				})
				expect(r.status).toBe(200)
				expect(await r.text()).toContain('BBBBBBBB')
			}
		})
		// The same build served again revalidates with 304 (the digest is stable).
		await serveOnce(v1, async (base) => {
			const r = await fetch(`${base}/index.html`, {
				headers: { 'if-none-match': etags['index.html'] ?? '' },
			})
			expect(r.status).toBe(304)
		})
		rmSync(parent, { recursive: true, force: true })
	})

	test('symbolic links: an escape is a 404, a link inside the root is served (RT-112)', async () => {
		const parent = mkdtempSync(join(tmpdir(), 'kora-links-'))
		const root = join(parent, 'public')
		mkdirSync(join(parent, 'private', 'site'), { recursive: true })
		mkdirSync(root)
		writeFileSync(join(parent, 'private', 'secret.txt'), 'secret')
		writeFileSync(join(parent, 'private', 'site', 'index.html'), 'private')
		writeFileSync(join(root, 'real.txt'), 'inside')
		symlinkSync(join(parent, 'private', 'secret.txt'), join(root, 'leak.txt'))
		symlinkSync(join(parent, 'private', 'site'), join(root, 'site'), 'dir')
		symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'))
		// A deploy that swaps a `current` link to a new release is followed per request.
		symlinkSync(root, join(parent, 'current'), 'dir')
		await serveOnce(join(parent, 'current'), async (base) => {
			expect((await fetch(`${base}/leak.txt`)).status).toBe(404)
			expect((await fetch(`${base}/site/`)).status).toBe(404)
			const alias = await fetch(`${base}/alias.txt`)
			expect(alias.status).toBe(200)
			expect(await alias.text()).toBe('inside')
		})
		rmSync(parent, { recursive: true, force: true })
	})
})

/** A GET with exactly these headers (no Sec-Fetch-*), like a link-preview crawler. */
function crawlerGet(
	url: string,
	headers: Record<string, string> = {},
): Promise<{
	status: number
	body: string
	headers: Record<string, string | string[] | undefined>
}> {
	return new Promise((done, fail) => {
		const req = request(url, { method: 'GET', headers }, (res) => {
			const chunks: Buffer[] = []
			res.on('data', (chunk: Buffer) => chunks.push(chunk))
			res.on('end', () =>
				done({
					status: res.statusCode ?? 0,
					body: Buffer.concat(chunks).toString('utf8'),
					headers: res.headers,
				}),
			)
		})
		req.on('error', fail)
		req.end()
	})
}

describe('page requests from crawlers (beta.15)', () => {
	let dir: string
	let servers: Server[] = []
	const bases: Record<'navigation' | 'strict', string> = { navigation: '', strict: '' }

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-static-crawl-'))
		mkdirSync(join(dir, 'assets'))
		writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>shell</h1>')
		for (const mode of ['navigation', 'strict'] as const) {
			const handle = createStaticFileHandler(
				dir,
				mode === 'strict' ? { spaFallback: 'strict' } : {},
			)
			const server = createServer((req, res) => {
				const url = new URL(req.url ?? '/', 'http://x')
				void handle(req, res, url.pathname)
			})
			await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
			servers.push(server)
			bases[mode] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		}
	})
	afterAll(async () => {
		for (const server of servers) await new Promise<void>((done) => server.close(() => done()))
		servers = []
		rmSync(dir, { recursive: true, force: true })
	})

	test.each([
		['facebookexternalhit/1.1', '*/*'],
		['WhatsApp/2.23.20.0', '*/*;q=0.8'],
		['Slackbot-LinkExpanding 1.0', ''],
	])('%s asking for "%s" gets the shell for an app route', async (agent, accept) => {
		const r = await crawlerGet(`${bases.navigation}/f/survey`, {
			'user-agent': agent,
			...(accept ? { accept } : {}),
		})
		expect(r.status).toBe(200)
		expect(r.body).toContain('shell')
	})

	test('API-looking paths, files and assets stay 404 for non-browser clients', async () => {
		for (const path of [
			'/api/forms/typo',
			'/api',
			'/__kora/nope',
			'/missing.js',
			'/assets/chunk',
		]) {
			expect((await crawlerGet(`${bases.navigation}${path}`, { accept: '*/*' })).status, path).toBe(
				404,
			)
		}
	})

	test('a client asking for JSON is not a page request', async () => {
		expect(
			(await crawlerGet(`${bases.navigation}/f/survey`, { accept: 'application/json' })).status,
		).toBe(404)
		expect(
			(await crawlerGet(`${bases.navigation}/f/survey`, { accept: 'application/json, */*' }))
				.status,
		).toBe(404)
	})

	test('a browser fetch() (it sends Sec-Fetch-Mode) of a missing path stays a 404', async () => {
		const r = await crawlerGet(`${bases.navigation}/f/survey`, {
			accept: '*/*',
			'sec-fetch-mode': 'cors',
		})
		expect(r.status).toBe(404)
	})

	test("'strict' answers browser navigations only", async () => {
		expect((await crawlerGet(`${bases.strict}/f/survey`, { accept: '*/*' })).status).toBe(404)
		expect((await crawlerGet(`${bases.strict}/f/survey`, { accept: 'text/html' })).status).toBe(200)
	})
})

describe('transformShell (per-URL metadata)', () => {
	let dir: string
	let server: Server
	let base: string
	let calls: string[] = []

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-static-meta-'))
		mkdirSync(join(dir, 'docs'))
		writeFileSync(
			join(dir, 'index.html'),
			`<!doctype html><html><head><title>App</title></head><body>${'x'.repeat(2000)}</body></html>`,
		)
		writeFileSync(join(dir, 'docs', 'index.html'), '<h1>docs</h1>')
		writeFileSync(join(dir, 'app.js'), 'console.log(1)')
		const handle = createStaticFileHandler(dir, {
			transformShell: async (_req, pathname, html) => {
				calls.push(pathname)
				if (pathname === '/boom') throw new Error('lookup failed')
				if (!pathname.startsWith('/f/')) return null
				return html.replace('<title>App</title>', `<title>${pathname}</title>`)
			},
		})
		server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://x')
			void handle(req, res, url.pathname)
		})
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})
	afterAll(async () => {
		await new Promise<void>((done) => server.close(() => done()))
		rmSync(dir, { recursive: true, force: true })
	})

	test("the shell served for a route carries that route's metadata, revalidated", async () => {
		const r = await crawlerGet(`${base}/f/one`, { accept: '*/*' })
		expect(r.status).toBe(200)
		expect(r.body).toContain('<title>/f/one</title>')
		expect(r.headers['cache-control']).toBe('no-cache')
		expect(r.headers['content-type']).toMatch(/text\/html/)
		const other = await crawlerGet(`${base}/f/two`, { accept: '*/*' })
		expect(other.body).toContain('<title>/f/two</title>')
		expect(other.headers.etag).not.toBe(r.headers.etag)
	})

	test('a matching ETag yields 304; compression is negotiated', async () => {
		const first = await crawlerGet(`${base}/f/one`, {
			accept: 'text/html',
			'accept-encoding': 'br',
		})
		const etag = String(first.headers.etag ?? '')
		expect(first.headers['content-encoding']).toBe('br')
		expect(etag).toMatch(/-br"$/)
		const again = await crawlerGet(`${base}/f/one`, {
			accept: 'text/html',
			'accept-encoding': 'br',
			'if-none-match': etag,
		})
		expect(again.status).toBe(304)
		// Another encoding is another representation: a full response, not a 304.
		const gzip = await crawlerGet(`${base}/f/one`, {
			accept: 'text/html',
			'accept-encoding': 'gzip',
			'if-none-match': etag,
		})
		expect(gzip.status).toBe(200)
	})

	test('null keeps the build file; a throw serves it unchanged; non-shell files are untouched', async () => {
		calls = []
		expect(
			await (await fetch(`${base}/elsewhere`, { headers: { accept: 'text/html' } })).text(),
		).toContain('<title>App</title>')
		expect(
			await (await fetch(`${base}/boom`, { headers: { accept: 'text/html' } })).text(),
		).toContain('<title>App</title>')
		expect(await (await fetch(`${base}/`)).text()).toContain('<title>App</title>')
		expect(await (await fetch(`${base}/docs/`)).text()).toContain('docs')
		expect(await (await fetch(`${base}/app.js`)).text()).toContain('console')
		expect(calls).toEqual(['/elsewhere', '/boom', '/'])
	})
})
