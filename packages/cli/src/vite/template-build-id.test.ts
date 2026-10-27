import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { BUILD_ID_PLACEHOLDER } from './build-id'
import { koraServiceWorker } from './service-worker'

/**
 * The producer of the build id the version gate reads (`createApp()` falls back to
 * `<meta name="kora-build">`): a real `vite build` with the plugin every web template uses.
 * Vite comes from the e2e fixture app (a workspace member), so the CLI needs no dependency.
 */

const repo = resolve(__dirname, '../../../..')
const templates = join(repo, 'packages/cli/templates')

interface ViteBuild {
	build(config: Record<string, unknown>): Promise<unknown>
}

async function loadVite(): Promise<ViteBuild> {
	const require = createRequire(join(repo, 'e2e/fixture-app/package.json'))
	return (await import(pathToFileURL(require.resolve('vite')).href)) as ViteBuild
}

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Build a minimal app with `koraServiceWorker()`; returns the stamped build id. */
async function buildApp(vite: ViteBuild, mainSource: string): Promise<string> {
	// Vite canonicalizes its root. Keep the absolute outDir under that same spelling too
	// (`/tmp` is a symlink on macOS), otherwise Rollup sees an output outside the root.
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'kora-template-build-')))
	dirs.push(root)
	writeFileSync(
		join(root, 'index.html'),
		'<!doctype html><html><head><title>app</title></head><body><script type="module" src="/main.js"></script></body></html>',
	)
	writeFileSync(join(root, 'main.js'), mainSource)
	await vite.build({
		root,
		configFile: false,
		logLevel: 'silent',
		plugins: [koraServiceWorker()],
		build: { outDir: join(root, 'dist'), emptyOutDir: true },
	})
	const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8')
	const match = /<meta\s+name="kora-build"\s+content="([^"]*)"/.exec(html)
	expect(readdirSync(join(root, 'dist'))).toContain('sw.js')
	return match?.[1] ?? ''
}

describe('template builds carry a build id', () => {
	test('every web template uses koraServiceWorker(), which injects the build id', () => {
		const web = readdirSync(templates).filter((name) => !name.startsWith('tauri'))
		expect(web.length).toBeGreaterThan(0)
		for (const name of web) {
			const config = readFileSync(join(templates, name, 'vite.config.ts'), 'utf8')
			expect(config, name).toContain('koraServiceWorker()')
		}
	})

	test('a vite build stamps a real id; a code change gives a distinct id, the same code the same id', async () => {
		const vite = await loadVite()
		const first = await buildApp(vite, 'console.log("deployment 1")\n')
		const same = await buildApp(vite, 'console.log("deployment 1")\n')
		const changed = await buildApp(vite, 'console.log("deployment 2")\n')
		for (const id of [first, same, changed]) {
			expect(id).toMatch(/^[0-9a-f]{16}$/)
			expect(id).not.toBe(BUILD_ID_PLACEHOLDER)
		}
		expect(same).toBe(first)
		expect(changed).not.toBe(first)
	}, 60_000)
})
