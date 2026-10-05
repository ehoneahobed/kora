/**
 * RT-112 repro (Codex review of PR #4, server/static-files.ts): the static file handler
 * contained request paths lexically (`resolve(join(root, path))` under `root`), but then
 * `stat` and `createReadStream` follow symbolic links. A link inside `staticDir` that
 * points outside it (a file link, a directory link, or a directory whose `index.html`
 * fallback is reached through one) served files from anywhere the process can read.
 *
 * Asserts the CORRECT behaviour: a path whose real location is outside the real static
 * directory is a 404 (not 403: the server does not reveal what exists), for files and
 * directory-index fallbacks; links that stay inside the directory, and a static directory
 * that is itself reached through a link, keep working.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createStaticFileHandler } from '../../src/server/static-files'

let base: string
let linkedBase: string
let top: string
const servers: Server[] = []

async function listen(staticDir: string): Promise<string> {
	const handle = createStaticFileHandler(staticDir)
	const server = createServer((req, res) => {
		void handle(req, res, new URL(req.url ?? '/', 'http://x').pathname)
	})
	servers.push(server)
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(async () => {
	top = mkdtempSync(join(tmpdir(), 'rt-112-'))
	const root = join(top, 'public')
	const outside = join(top, 'private')
	mkdirSync(join(root, 'assets'), { recursive: true })
	mkdirSync(join(outside, 'site'), { recursive: true })
	writeFileSync(join(root, 'index.html'), '<!doctype html><h1>shell</h1>')
	writeFileSync(join(root, 'assets', 'app.js'), 'console.log("app")')
	writeFileSync(join(root, 'real.txt'), 'inside')
	writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
	writeFileSync(join(outside, 'site', 'index.html'), '<h1>private index</h1>')
	// Links that escape the static directory.
	symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))
	symlinkSync(outside, join(root, 'leak'), 'dir')
	symlinkSync(join(outside, 'site'), join(root, 'docs'), 'dir')
	// Links that stay inside it.
	symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'))
	symlinkSync(join(root, 'assets'), join(root, 'static'), 'dir')
	// The static directory itself reached through a link.
	symlinkSync(root, join(top, 'current'), 'dir')

	base = await listen(root)
	linkedBase = await listen(join(top, 'current'))
})

afterAll(async () => {
	for (const server of servers) await new Promise((done) => server.close(done))
	rmSync(top, { recursive: true, force: true })
})

async function get(url: string, headers: Record<string, string> = {}) {
	const response = await fetch(url, { headers })
	return { status: response.status, body: await response.text() }
}

describe('RT-112: static files never follow a link out of the static directory', () => {
	test('a file link pointing outside is a 404', async () => {
		expect(await get(`${base}/leak.txt`)).toEqual({ status: 404, body: 'Not Found' })
	})

	test('a file under a directory link pointing outside is a 404', async () => {
		expect(await get(`${base}/leak/secret.txt`)).toEqual({ status: 404, body: 'Not Found' })
	})

	test('a directory-index fallback through a link pointing outside is a 404', async () => {
		expect(await get(`${base}/docs/`)).toEqual({ status: 404, body: 'Not Found' })
		expect(await get(`${base}/docs/index.html`)).toEqual({ status: 404, body: 'Not Found' })
		// A navigation gets the app shell, never the private index.
		const navigation = await get(`${base}/docs/`, { Accept: 'text/html' })
		expect(navigation.body).toContain('shell')
	})

	test('links that stay inside the directory keep working', async () => {
		expect(await get(`${base}/alias.txt`)).toEqual({ status: 200, body: 'inside' })
		expect(await get(`${base}/static/app.js`)).toEqual({
			status: 200,
			body: 'console.log("app")',
		})
	})

	test('a static directory reached through a link serves its files and refuses escapes', async () => {
		expect(await get(`${linkedBase}/real.txt`)).toEqual({ status: 200, body: 'inside' })
		expect(await get(`${linkedBase}/assets/app.js`)).toEqual({
			status: 200,
			body: 'console.log("app")',
		})
		expect((await get(`${linkedBase}/leak.txt`)).status).toBe(404)
	})
})
