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
