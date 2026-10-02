import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

/**
 * LMS-13 (external report, Part D #13): static-file caching headers.
 *
 * Starts the real createProductionServer over a Vite-shaped dist/ (including the two
 * UNHASHED files Kora's own templates copy into dist/assets: sqlite3.wasm and
 * sqlite3-opfs-async-proxy.js) and asserts what a correct static server must do.
 */
let dir: string
let base: string
let stop: () => Promise<void>
const bundle = readFileSync(join(__dirname, '../../../sync/dist/index.js')) // ~177 KB real JS

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'kora-lms13-'))
	mkdirSync(join(dir, 'assets'))
	writeFileSync(
		join(dir, 'index.html'),
		'<!doctype html><script src="/assets/index-DrBNyszg.js"></script>',
	)
	writeFileSync(join(dir, 'assets', 'index-DrBNyszg.js'), bundle)
	writeFileSync(join(dir, 'assets', 'sqlite3.wasm'), Buffer.alloc(1024, 1))
	writeFileSync(join(dir, 'assets', 'sqlite3-opfs-async-proxy.js'), 'self.onmessage=()=>{}')
	writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch",()=>{})')
	writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"lms"}')
	const server = createProductionServer({
		store: new MemoryServerStore('s'),
		port: 0,
		staticDir: dir,
	})
	const port = Number(new URL(await server.start()).port)
	base = `http://127.0.0.1:${port}`
	stop = () => server.stop()
})
afterAll(async () => {
	await stop?.()
	rmSync(dir, { recursive: true, force: true })
})

function headerObject(r: Response): Record<string, string> {
	const out: Record<string, string> = {}
	r.headers.forEach((v, k) => {
		out[k] = v
	})
	return out
}

async function head(path: string, headers: Record<string, string> = {}): Promise<Response> {
	const r = await fetch(base + path, { headers })
	await r.arrayBuffer()
	return r
}

describe('LMS-13: HEAD static headers (observed)', () => {
	test('dump headers', async () => {
		for (const p of [
			'/',
			'/assets/index-DrBNyszg.js',
			'/assets/sqlite3.wasm',
			'/sw.js',
			'/manifest.webmanifest',
			'/assets/index-OLDHASH1.js',
		]) {
			const r = await head(p, { 'accept-encoding': 'gzip, br' })
			console.log(`[LMS-13] ${p} -> ${r.status} ${JSON.stringify(headerObject(r))}`)
		}
		const gz = gzipSync(bundle).length
		const br = brotliCompressSync(bundle).length
		const kbps = 50 // effective 2G/EDGE goodput
		const secs = (bytes: number): string => ((bytes * 8) / (kbps * 1000)).toFixed(1)
		console.log(
			`[LMS-13] 177 KB bundle: identity ${bundle.length} B (${secs(bundle.length)} s @${kbps} kbps), gzip ${gz} B (${secs(gz)} s), brotli ${br} B (${secs(br)} s)`,
		)
	})
})

describe('LMS-13: correct behaviour', () => {
	test('content-hashed asset is cached immutably for a year', async () => {
		const r = await head('/assets/index-DrBNyszg.js')
		expect(r.headers.get('cache-control') ?? '').toMatch(
			/max-age=31536000.*immutable|immutable.*max-age=31536000/,
		)
	})
	test('index.html, sw.js and the manifest must revalidate (no-cache)', async () => {
		for (const p of ['/', '/sw.js', '/manifest.webmanifest']) {
			expect((await head(p)).headers.get('cache-control') ?? '').toMatch(/no-cache/)
		}
	})
	test('UNHASHED files Kora copies into dist/assets must NOT be immutable', async () => {
		for (const p of ['/assets/sqlite3.wasm', '/assets/sqlite3-opfs-async-proxy.js']) {
			const cc = (await head(p)).headers.get('cache-control') ?? ''
			expect(cc).not.toMatch(/immutable/)
			expect(cc).toMatch(/no-cache|must-revalidate|max-age=\d{1,4}\b/)
		}
	})
	test('a validator is sent and a conditional request gets 304', async () => {
		const r = await head('/')
		const etag = r.headers.get('etag')
		const lm = r.headers.get('last-modified')
		expect(etag ?? lm).toBeTruthy()
		const r2 = await head('/', etag ? { 'if-none-match': etag } : { 'if-modified-since': lm ?? '' })
		expect(r2.status).toBe(304)
	})
	test('compressible responses are compressed when the client accepts it', async () => {
		const r = await head('/assets/index-DrBNyszg.js', { 'accept-encoding': 'gzip, br' })
		expect(r.headers.get('content-encoding') ?? '').toMatch(/br|gzip/)
		expect(r.headers.get('vary') ?? '').toMatch(/accept-encoding/i)
	})
	test('a missing hashed asset is 404, not index.html with 200 (stale tab after deploy)', async () => {
		const r = await head('/assets/index-OLDHASH1.js')
		expect(r.status).toBe(404)
	})
	test('webmanifest has a proper media type', async () => {
		expect((await head('/manifest.webmanifest')).headers.get('content-type')).toMatch(
			/manifest\+json/,
		)
	})
})

describe("LMS-13: the report's heuristic (pure function) — defects", () => {
	// Verbatim from the report.
	const reportHeuristic = (filePath: string): string =>
		filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
	test('marks Kora-template unhashed sqlite3.wasm immutable for a year (defect)', () => {
		expect(reportHeuristic('/app/dist/assets/sqlite3.wasm')).toMatch(/immutable/)
	})
	test('marks index.html immutable when the deploy path contains /assets/ (defect)', () => {
		expect(reportHeuristic('/srv/assets/lms/dist/index.html')).toMatch(/immutable/)
	})
	test('never matches on Windows paths (defect)', () => {
		expect(reportHeuristic('C:\\app\\dist\\assets\\index-DrBNyszg.js')).toBe('no-cache')
	})
})
