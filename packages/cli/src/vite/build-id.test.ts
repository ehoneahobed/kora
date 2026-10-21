import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
		write('index.html', `${page()}<!-- edited -->`)
		write('sw.js', 'self.VERSION = 1')
		expect(outputBuildId(dir)).toBe(publicChanged)
		write('assets/late-generated.json', '{}')
		expect(outputBuildId(dir)).not.toBe(publicChanged)
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
		expect(html).toContain(`content="${outputBuildId(dir)}"`)

		const off = koraServiceWorker({ buildId: false })
		off.configResolved({ root: dir, base: '/', command: 'build', build: { outDir: '.' } })
		expect(
			off.transformIndexHtml('<html></html>').tags.some((tag) => tag.attrs?.name === 'kora-build'),
		).toBe(false)
	})
})
