import { describe, expect, test } from 'vitest'
import { type BundleFile, bundleBuildId, koraBuildId } from './build-id'
import { koraServiceWorker } from './service-worker'

function bundle(
	files: Array<Partial<BundleFile> & { fileName: string }>,
): Record<string, BundleFile> {
	return Object.fromEntries(
		files.map((file) => [file.fileName, { type: 'chunk', ...file } as BundleFile]),
	)
}

const base = [
	{ fileName: 'assets/index-abc.js', code: 'console.log(1)' },
	{ fileName: 'assets/index-def.css', type: 'asset' as const, source: 'body{}' },
]

describe('bundleBuildId', () => {
	test('stable for identical output, independent of order', () => {
		const one = bundleBuildId(bundle(base))
		const two = bundleBuildId(bundle([...base].reverse()))
		expect(one).toBe(two)
		expect(one).toMatch(/^[0-9a-f]{16}$/)
	})

	test('differs when any emitted file differs; the HTML page is not hashed', () => {
		const original = bundleBuildId(bundle(base))
		expect(
			bundleBuildId(bundle([{ ...base[0], code: 'console.log(2)' } as (typeof base)[0], base[1]])),
		).not.toBe(original)
		expect(
			bundleBuildId(bundle([...base, { fileName: 'assets/worker-1.js', code: 'x' }])),
		).not.toBe(original)
		expect(
			bundleBuildId(bundle([...base, { fileName: 'index.html', type: 'asset', source: '<html>' }])),
		).toBe(original)
		expect(
			bundleBuildId(
				bundle([
					base[0] as (typeof base)[0],
					{
						fileName: 'assets/index-def.css',
						type: 'asset',
						source: new TextEncoder().encode('body{}'),
					},
				]),
			),
		).toBe(original)
	})
})

describe('koraBuildId()', () => {
	test('injects <meta name="kora-build"> with the bundle hash in a build', () => {
		const plugin = koraBuildId()
		plugin.configResolved({ command: 'build' })
		const { tags } = plugin.transformIndexHtml('<html></html>', { bundle: bundle(base) })
		expect(tags).toEqual([
			{
				tag: 'meta',
				attrs: { name: 'kora-build', content: bundleBuildId(bundle(base)) },
				injectTo: 'head-prepend',
			},
		])
	})

	test('a dev server gets one dev id for its life', () => {
		const plugin = koraBuildId()
		plugin.configResolved({ command: 'serve' })
		const first = plugin.transformIndexHtml('<html></html>').tags[0]?.attrs?.content
		const second = plugin.transformIndexHtml('<html></html>').tags[0]?.attrs?.content
		expect(first).toMatch(/^dev-/)
		expect(second).toBe(first)
	})

	test('a build hook without a bundle injects nothing (never a guessed id)', () => {
		const plugin = koraBuildId()
		plugin.configResolved({ command: 'build' })
		expect(plugin.transformIndexHtml('<html></html>').tags).toEqual([])
	})
})

describe('koraServiceWorker() includes the build id', () => {
	const resolved = { root: '/x', base: '/', command: 'build' as const, build: { outDir: 'dist' } }

	test('by default', () => {
		const plugin = koraServiceWorker()
		plugin.configResolved(resolved)
		const { tags } = plugin.transformIndexHtml('<html></html>', { bundle: bundle(base) })
		expect(tags).toContainEqual(
			expect.objectContaining({
				tag: 'meta',
				attrs: { name: 'kora-build', content: bundleBuildId(bundle(base)) },
			}),
		)
	})

	test('not with buildId: false', () => {
		const plugin = koraServiceWorker({ buildId: false })
		plugin.configResolved(resolved)
		const { tags } = plugin.transformIndexHtml('<html></html>', { bundle: bundle(base) })
		expect(tags.some((tag) => tag.attrs?.name === 'kora-build')).toBe(false)
	})
})
