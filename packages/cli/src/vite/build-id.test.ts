import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BUILD_ID_PLACEHOLDER, koraBuildId, outputBuildId, stampBuildId } from './build-id'
import { koraServiceWorker } from './service-worker'

let dir: string

function write(rel: string, content: string | Uint8Array): void {
	const full = join(dir, rel)
	mkdirSync(dirname(full), { recursive: true })
	writeFileSync(full, content)
}

function page(): string {
	return `<html><head><meta name="kora-build" content="${BUILD_ID_PLACEHOLDER}"></head></html>`
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-build-id-'))
	write('index.html', page())
	write('assets/index-abc.js', 'console.log(1)')
	write('assets/index-def.css', 'body{}')
	write('legacy/mutations.js', 'export const v = 1') // copied from publicDir
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe('outputBuildId', () => {
	test('stable for identical output', () => {
		const id = outputBuildId(dir)
		expect(id).toMatch(/^[0-9a-f]{16}$/)
		expect(outputBuildId(dir)).toBe(id)
	})

	test('changes with any deployed file, public ones included; not with HTML or sw.js', () => {
		const original = outputBuildId(dir)
		write('legacy/mutations.js', 'export const v = 2')
		const publicChanged = outputBuildId(dir)
		expect(publicChanged).not.toBe(original)
		// The worker koraServiceWorker() generates is excluded by that plugin only.
		write('sw.js', 'self.VERSION = 1')
		expect(outputBuildId(dir, ['sw.js'])).toBe(outputBuildId(dir, ['sw.js']))
		expect(outputBuildId(dir, ['sw.js'])).not.toBe(outputBuildId(dir))
		rmSync(join(dir, 'sw.js'))
		expect(outputBuildId(dir)).toBe(publicChanged)
		// An inline script or an import map in a page is application code.
		write('index.html', `${page()}<script>window.config = { flag: true }</script>`)
		const htmlChanged = outputBuildId(dir)
		expect(htmlChanged).not.toBe(publicChanged)
		write('index.html', `${page()}<script>window.config = { flag: true }</script>`)
		write('assets/late-generated.json', '{}')
		expect(outputBuildId(dir)).not.toBe(htmlChanged)
	})

	test('sourcemaps, compressed copies and dotfiles are not hashed', () => {
		const original = outputBuildId(dir)
		write('assets/index-abc.js.map', '{"sourceRoot":"/home/ci-runner-7/app"}')
		write('assets/index-abc.js.br', 'compressed')
		write('assets/index-abc.js.gz', 'compressed')
		write('.DS_Store', 'x')
		write('.cache/data', 'x')
		expect(outputBuildId(dir)).toBe(original)
		write('assets/index-abc.js.map', '{"sourceRoot":"/home/ci-runner-9/app"}')
		expect(outputBuildId(dir)).toBe(original)
	})

	test('file boundaries are unambiguous (NUL bytes in content)', () => {
		const a = mkdtempSync(join(tmpdir(), 'kora-build-id-a-'))
		const b = mkdtempSync(join(tmpdir(), 'kora-build-id-b-'))
		try {
			writeFileSync(join(a, 'x'), 'foo\0y\0bar')
			writeFileSync(join(b, 'x'), 'foo')
			writeFileSync(join(b, 'y'), 'bar')
			expect(outputBuildId(a)).not.toBe(outputBuildId(b))
		} finally {
			rmSync(a, { recursive: true, force: true })
			rmSync(b, { recursive: true, force: true })
		}
	})
})

describe('stamping', () => {
	test('every built page gets the id in place of the placeholder', () => {
		write('admin/index.html', page())
		const id = outputBuildId(dir)
		expect(stampBuildId(dir, id)).toHaveLength(2)
		expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(`content="${id}"`)
		expect(readFileSync(join(dir, 'admin/index.html'), 'utf8')).not.toContain(BUILD_ID_PLACEHOLDER)
		// Stamping changes only HTML, so the id stays the same.
		expect(outputBuildId(dir)).toBe(id)
	})

	test('koraBuildId(): placeholder at transform, stamped at closeBundle; dev id in dev', () => {
		const plugin = koraBuildId()
		plugin.configResolved({ root: dir, command: 'build', build: { outDir: '.' } })
		expect(plugin.transformIndexHtml('<html></html>').tags[0]?.attrs?.content).toBe(
			BUILD_ID_PLACEHOLDER,
		)
		plugin.closeBundle.handler()
		expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(
			`content="${outputBuildId(dir)}"`,
		)
		const dev = koraBuildId()
		dev.configResolved({ root: dir, command: 'serve', build: { outDir: '.' } })
		const first = dev.transformIndexHtml('<html></html>').tags[0]?.attrs?.content
		expect(first).toMatch(/^dev-/)
		expect(dev.transformIndexHtml('<html></html>').tags[0]?.attrs?.content).toBe(first)
	})
})

describe('both plugins', () => {
	test('the meta tag is injected once, by whichever plugin runs first; both stamp the same id', () => {
		const ids = koraBuildId()
		const shell = koraServiceWorker()
		ids.configResolved({ root: dir, command: 'build', build: { outDir: '.' } })
		shell.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: '.' } })
		const injected = `<html><head><meta name="kora-build" content="${BUILD_ID_PLACEHOLDER}"></head></html>`
		expect(ids.transformIndexHtml(injected).tags).toEqual([])
		expect(
			shell.transformIndexHtml(injected).tags.some((tag) => tag.attrs?.name === 'kora-build'),
		).toBe(false)
		shell.closeBundle.handler()
		const stamped = readFileSync(join(dir, 'index.html'), 'utf8')
		ids.closeBundle.handler()
		expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(stamped)
	})
})

describe('koraServiceWorker() includes the build id', () => {
	test('stamps the pages before precaching them, unless buildId: false', () => {
		const plugin = koraServiceWorker()
		plugin.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: '.' } })
		expect(
			plugin
				.transformIndexHtml('<html></html>')
				.tags.some((tag) => tag.attrs?.name === 'kora-build'),
		).toBe(true)
		plugin.closeBundle.handler()
		const html = readFileSync(join(dir, 'index.html'), 'utf8')
		expect(html).not.toContain(BUILD_ID_PLACEHOLDER)
		expect(html).toContain(`content="${outputBuildId(dir, ['sw.js'])}"`)

		const off = koraServiceWorker({ buildId: false })
		off.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: '.' } })
		expect(
			off.transformIndexHtml('<html></html>').tags.some((tag) => tag.attrs?.name === 'kora-build'),
		).toBe(false)
	})
})

describe('Codex re-audit of the build id plugin', () => {
	const fresh = (): void => {
		rmSync(dir, { recursive: true, force: true })
		mkdirSync(dir, { recursive: true })
	}

	test('precompressed copies of a stamped page are regenerated: index.html.gz / .br never carry the placeholder', () => {
		const html = page()
		write('index.html.gz', gzipSync(Buffer.from(html)))
		write('index.html.br', brotliCompressSync(Buffer.from(html)))
		const id = outputBuildId(dir)
		stampBuildId(dir, id)
		const gz = gunzipSync(readFileSync(join(dir, 'index.html.gz'))).toString('utf8')
		const br = brotliDecompressSync(readFileSync(join(dir, 'index.html.br'))).toString('utf8')
		for (const served of [gz, br]) {
			expect(served).toContain(`content="${id}"`)
			expect(served).not.toContain(BUILD_ID_PLACEHOLDER)
		}
		expect(gz).toBe(readFileSync(join(dir, 'index.html'), 'utf8'))
	})

	test('an authored kora-build tag gets its content replaced (either attribute order), never kept', () => {
		const ids = koraBuildId()
		ids.configResolved({ root: dir, command: 'build', build: { outDir: '.' } })
		const shell = koraServiceWorker()
		shell.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: '.' } })
		for (const authored of [
			'<html><head><meta name="kora-build" content="constant"></head></html>',
			"<html><head><meta content='constant' name='kora-build'></head></html>",
		]) {
			for (const result of [ids.transformIndexHtml(authored), shell.transformIndexHtml(authored)]) {
				expect(result.html).not.toContain('constant')
				expect(result.html).toContain(BUILD_ID_PLACEHOLDER)
				expect(result.tags.filter((tag) => tag.attrs?.name === 'kora-build')).toEqual([])
			}
		}
	})

	test('only the meta tag is stamped: the placeholder string elsewhere in a page is application content', () => {
		write('index.html', `${page()}<script>window.literal = "${BUILD_ID_PLACEHOLDER}"</script>`)
		const id = outputBuildId(dir)
		stampBuildId(dir, id)
		const html = readFileSync(join(dir, 'index.html'), 'utf8')
		expect(html).toContain(`content="${id}"`)
		expect(html).toContain(`window.literal = "${BUILD_ID_PLACEHOLDER}"`)
		expect(outputBuildId(dir)).toBe(id)
	})

	test('a standalone .gz / .br asset is hashed; only a compressed copy of another emitted file is skipped', () => {
		write('data/config.json.gz', gzipSync(Buffer.from('{"flag":1}')))
		const before = outputBuildId(dir)
		write('data/config.json.gz', gzipSync(Buffer.from('{"flag":2}')))
		expect(outputBuildId(dir)).not.toBe(before)
		write('data/model.bin.br', brotliCompressSync(Buffer.from('v1')))
		const withBr = outputBuildId(dir)
		write('data/model.bin.br', brotliCompressSync(Buffer.from('v2')))
		expect(outputBuildId(dir)).not.toBe(withBr)
	})

	test('standalone koraBuildId() hashes a sw.js the app ships; koraServiceWorker() excludes only its own', () => {
		const stampWith = (worker: string): string => {
			fresh()
			write('index.html', page())
			write('sw.js', worker)
			const plugin = koraBuildId()
			plugin.configResolved({ root: dir, command: 'build', build: { outDir: '.' } })
			plugin.closeBundle.handler()
			return /content="([^"]+)"/.exec(readFileSync(join(dir, 'index.html'), 'utf8'))?.[1] ?? ''
		}
		expect(stampWith('self.offline = "v1"')).not.toBe(stampWith('self.offline = "v2"'))
	})

	test('koraServiceWorker() stamps every page, multi-page and nested, with or without a root index.html', () => {
		fresh()
		write('admin.html', page())
		write('nested/index.html', page())
		write('assets/app.js', 'console.log(1)')
		const plugin = koraServiceWorker()
		plugin.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: '.' } })
		plugin.closeBundle.handler()
		for (const rel of ['admin.html', 'nested/index.html']) {
			const html = readFileSync(join(dir, rel), 'utf8')
			expect(html).not.toContain(BUILD_ID_PLACEHOLDER)
			expect(html).toMatch(/content="[0-9a-f]{16}"/)
		}
		// No root page: no shell worker is generated (unchanged), but the pages are stamped.
		expect(existsSync(join(dir, 'sw.js'))).toBe(false)
	})

	test('sibling: the offline shell precaches a standalone .gz asset, never a compressed copy of another file', async () => {
		const { collectPrecache } = await import('./service-worker')
		fresh()
		write('index.html', page())
		write('assets/app.js', 'console.log(1)')
		write('assets/app.js.gz', gzipSync(Buffer.from('console.log(1)')))
		write('data/config.json.gz', gzipSync(Buffer.from('{}')))
		const { urls } = collectPrecache(dir, '/')
		expect(urls).toContain('/data/config.json.gz')
		expect(urls).not.toContain('/assets/app.js.gz')
	})
})
