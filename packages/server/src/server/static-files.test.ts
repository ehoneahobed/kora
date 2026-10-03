import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
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
		writeFileSync(join(dir, 'assets', 'pre-AbCd1234.js.gz'), gzipSync('PRECOMPRESSED'))
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

	test('If-Modified-Since yields 304', async () => {
		const r = await fetch(`${base}/`)
		const lm = r.headers.get('last-modified') ?? ''
		expect(lm).toContain('2026')
		const r2 = await fetch(`${base}/`, { headers: { 'if-modified-since': lm } })
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

	test('a pre-compressed sibling is served when present', async () => {
		const r = await fetch(`${base}/assets/pre-AbCd1234.js`, {
			headers: { 'accept-encoding': 'gzip' },
		})
		expect(await r.text()).toBe('PRECOMPRESSED')
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
