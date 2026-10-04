/**
 * RT-99 repro (final RC red team, NEW-SRV-8): the production static server's validators
 * are derived from size and mtime only (`ETag: "<size>-<mtime>"`, `Last-Modified`). A
 * deploy whose files keep their size and modification time gets `304 Not Modified` for
 * changed content. Both conditions are common for exactly the files that must revalidate:
 * `index.html` and `sw.js` keep their size across deploys (fixed-length content hashes),
 * and reproducible or containerised builds normalise mtimes (SOURCE_DATE_EPOCH, Nix,
 * Bazel, archive extraction with a fixed date). The browser then keeps the old
 * `index.html` pointing at deleted hashed chunks (blank app), and the old `sw.js` is never
 * replaced, so no update is ever offered.
 *
 * Asserts CORRECT behaviour: a revalidation of changed content is answered 200 with a
 * different validator.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createStaticFileHandler } from '../../src/server/static-files'

let server: Server | null = null
let dir: string | null = null

afterEach(async () => {
	await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
	server = null
	if (dir) rmSync(dir, { recursive: true, force: true })
	dir = null
})

async function serve(root: string): Promise<string> {
	const handler = createStaticFileHandler(root)
	server = createServer((req, res) => {
		void handler(req, res, new URL(req.url ?? '/', 'http://x').pathname)
	})
	await new Promise<void>((done) => server?.listen(0, '127.0.0.1', () => done()))
	return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`
}

describe('RT-99: static validators ignore content', () => {
	test.each(['index.html', 'sw.js'])('a redeployed %s with the same size and mtime is not 304', async (name) => {
		dir = mkdtempSync(join(tmpdir(), 'rt99-'))
		const file = join(dir, name)
		const fixed = new Date('2026-01-01T00:00:00Z')
		// Same length, different hashed reference: what every deploy does to these files.
		const v1 = name === 'sw.js' ? 'const VERSION = "0123456789abcdef"\n' : '<script src="/assets/index-AAAAAAAA.js"></script>'
		const v2 = name === 'sw.js' ? 'const VERSION = "fedcba9876543210"\n' : '<script src="/assets/index-BBBBBBBB.js"></script>'
		writeFileSync(file, v1)
		utimesSync(file, fixed, fixed)
		const base = await serve(dir)

		const first = await fetch(`${base}/${name}`)
		const etag = first.headers.get('etag') ?? ''
		const lastModified = first.headers.get('last-modified') ?? ''
		expect(await first.text()).toBe(v1)

		// Deploy: new content, normalised mtime.
		writeFileSync(file, v2)
		utimesSync(file, fixed, fixed)

		const revalidate = await fetch(`${base}/${name}`, {
			headers: { 'if-none-match': etag, 'if-modified-since': lastModified },
		})
		expect(revalidate.status).toBe(200)
		expect(await revalidate.text()).toBe(v2)
	})

	test('the in-memory compressed body is not served for replaced content', async () => {
		// A server left running while the build directory is replaced in place (rsync, a
		// shared volume): the compressed-body cache is keyed by size and mtime too.
		dir = mkdtempSync(join(tmpdir(), 'rt99-'))
		const file = join(dir, 'app.js')
		const fixed = new Date('2026-01-01T00:00:00Z')
		const v1 = `${'a'.repeat(2048)}\n`
		const v2 = `${'b'.repeat(2048)}\n`
		writeFileSync(file, v1)
		utimesSync(file, fixed, fixed)
		const base = await serve(dir)
		const first = await fetch(`${base}/app.js`, { headers: { 'accept-encoding': 'gzip' } })
		expect(first.headers.get('content-encoding')).toBe('gzip')
		expect(await first.text()).toBe(v1)

		writeFileSync(file, v2)
		utimesSync(file, fixed, fixed)
		const fresh = await fetch(`${base}/app.js`, { headers: { 'accept-encoding': 'gzip' } })
		expect(await fresh.text()).toBe(v2)
	})
})
