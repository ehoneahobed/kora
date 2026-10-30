import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	assertReadyMeansOffline,
	expectNeverReady,
	goOffline,
	goOnline,
	openProfile,
	readOfflineStatus,
	restartProfile,
	waitForOfflineStatus,
} from '@korajs/test/playwright'
import type { Profile } from '@korajs/test/playwright'
import { type Page, chromium, expect, test } from '@playwright/test'
import {
	type RunningApp,
	type ScaffoldedApp,
	countingProxy,
	packWorkspace,
	scaffoldInstallBuild,
	serveApp,
} from './harness'
import { TEMPLATE_SPECS, type TemplateSpec, selectedTemplates } from './templates'

/**
 * The offline-readiness suite (A7): every bundled CLI template, scaffolded from the packed
 * packages, built for production, served the way the template says, then driven in real
 * Chromium with the network cut. `pnpm test:e2e:offline` runs it (all 13, or a subset through
 * `KORA_OFFLINE_TEMPLATES=react-basic,vue-sync`).
 *
 * Nothing waits on a timer: every step waits on a status, a selector or a response.
 */

const TODO_PLACEHOLDER = 'What needs to be done?'

function chromiumPath(): string | undefined {
	if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH
	const base = '/opt/pw-browsers'
	if (!existsSync(base)) return undefined
	for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d))) {
		for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
			const candidate = join(base, dir, sub)
			if (existsSync(candidate)) return candidate
		}
	}
	return undefined
}

async function addTodo(page: Page, title: string): Promise<void> {
	const input = page.getByPlaceholder(TODO_PLACEHOLDER)
	await input.fill(title)
	await input.press('Enter')
	await page.getByText(title, { exact: true }).first().waitFor({ state: 'visible' })
}

/**
 * Creates an account on the template's own auth server and signs in, online, once: a sync
 * template is `ready` offline only when the session can be restored without the network.
 */
async function signUp(page: Page, name: string): Promise<void> {
	await page.evaluate(
		(email) =>
			(
				globalThis as unknown as {
					authClient: { signUp(p: { email: string; password: string }): Promise<unknown> }
				}
			).authClient.signUp({ email, password: 'correct-horse-battery-staple-9' }),
		`${name}-${Date.now()}@example.test`,
	)
}

async function todoVisible(page: Page, title: string): Promise<boolean> {
	try {
		await page
			.getByText(title, { exact: true })
			.first()
			.waitFor({ state: 'visible', timeout: 15_000 })
		return true
	} catch {
		return false
	}
}

test('the suite covers exactly the templates the CLI bundles', async () => {
	const cliTypes = readFileSync(
		join(process.cwd(), '..', 'packages', 'cli', 'src', 'types.ts'),
		'utf8',
	)
	const block = /export const TEMPLATES = \[([\s\S]*?)\] as const/.exec(cliTypes)?.[1] ?? ''
	const bundled = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
	expect(TEMPLATE_SPECS.map((t) => t.name).sort()).toEqual(bundled)
	expect(bundled).toHaveLength(13)
})

for (const spec of selectedTemplates()) {
	if (spec.desktop) {
		test.describe(`${spec.name}`, () => {
			test('desktop template: not runnable in a browser, its contract is checked statically', () => {
				// `tauri build` produces a native binary with the interface embedded (no service worker)
				// and native SQLite, which Chromium cannot run. Its badge and bundled-shell status are
				// covered by unit tests (template-offline-badge.test.ts, the bundled state); a native
				// smoke belongs to a Tauri CI job.
				test.skip(true, 'tauri-react needs the Tauri runtime; see docs/guide/offline-readiness.md')
			})
		})
		continue
	}
	defineTemplateSuite(spec)
}

function defineTemplateSuite(spec: TemplateSpec): void {
	test.describe
		.serial(spec.name, () => {
			let built: ScaffoldedApp
			let running: RunningApp
			let profile: Profile
			let profileDir: string
			const seed = `seed ${spec.name}`
			const offlineWrite = `offline write ${spec.name}`

			test.beforeAll(async () => {
				test.setTimeout(15 * 60_000)
				built = scaffoldInstallBuild(spec, packWorkspace(), (line) =>
					console.log(`[${spec.name}] ${line}`),
				)
				running = await serveApp(built)
				profileDir = mkdtempSync(join(tmpdir(), `kora-offline-profile-${spec.name}-`))
				profile = await openProfile(chromium, profileDir, {
					headless: true,
					executablePath: chromiumPath(),
				})
			})

			test.afterAll(async () => {
				await profile?.context.close().catch(() => {})
				await running?.stop().catch(() => {})
				if (profileDir) rmSync(profileDir, { recursive: true, force: true })
			})

			test('ready means the app works offline: shell, data, a write, and the write survives', async () => {
				const page = await profile.context.newPage()
				await page.goto(running.origin)
				await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible()
				if (spec.sync) await signUp(page, spec.name)
				await addTodo(page, seed)

				const report = await assertReadyMeansOffline(page, {
					shellSelector: 'h1',
					dataSelector: `text="${seed}"`,
					timeoutMs: 120_000,
					write: (p) => addTodo(p, offlineWrite),
					verifyWrite: (p) => todoVisible(p, offlineWrite),
				})
				expect(report.steps).toEqual([
					'ready',
					'shell and data after offline reload',
					'offline write',
					'write survives reload',
				])
				await page.close()
			})

			test('offline status is reported while offline', async () => {
				const page = await profile.context.newPage()
				await goOffline(page)
				await page.goto(running.origin)
				await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible()
				const status = await waitForOfflineStatus(page, (s) => s.state === 'ready', {
					timeoutMs: 60_000,
				})
				expect(status.reasons).toEqual([])
				expect(status.shell).toMatchObject({ state: 'installed' })
				expect(status.storage).toMatchObject({ durable: true })
				// A sync template restores its session offline; a local-only one has no sign-in.
				expect(status.auth).toMatchObject({ state: spec.sync ? 'restorable' : 'n/a' })
				// What the user sees agrees with what the API says.
				await expect(
					page.locator('.offline-badge, output').filter({ hasText: 'Available offline' }).first(),
				).toBeVisible()
				await goOnline(page)
				await page.close()
			})

			test('data and writes survive a browser restart with no network', async () => {
				await restartProfile(profile, { offline: true })
				const page = await profile.context.newPage()
				await page.goto(running.origin)
				expect(await todoVisible(page, seed)).toBe(true)
				expect(await todoVisible(page, offlineWrite)).toBe(true)
				const restartWrite = `after restart ${spec.name}`
				await addTodo(page, restartWrite)
				await page.reload()
				expect(await todoVisible(page, restartWrite)).toBe(true)
				const status = await readOfflineStatus(page)
				expect(status?.storage).toMatchObject({ writes: 'durable' })
				await page.close()
			})

			if (spec.sync) {
				test('signed out, a sync template is never ready (its session cannot be restored offline)', async () => {
					// The sync templates sign in with Google only. Out of the box nobody is signed in, so the
					// badge honestly reads "Not available offline yet" although local data works: a
					// documented gap (see docs/guide/offline-readiness.md), pinned here so it cannot change
					// silently into a false "ready".
					const browser = await chromium.launch({ executablePath: chromiumPath() })
					const context = await browser.newContext()
					const page = await context.newPage()
					try {
						const report = await expectNeverReady(page, async () => {
							await page.goto(running.origin)
							await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible()
							await addTodo(page, 'signed out')
							await waitForOfflineStatus(page, (s) => s.reasons.includes('auth-not-restorable'), {
								timeoutMs: 60_000,
							})
						})
						expect(report.reasonsSeen).toContain('auth-not-restorable')
						report.assertNeverReady()
					} finally {
						await context.close()
						await browser.close()
					}
				})
			}

			test('a cold first load downloads the main bundle and the SQLite WASM once, precache after them', async () => {
				// First-visit parity S1 (design 5.8): the shell's precache reuses the HTTP cache and
				// stores the unhashed sqlite3.wasm copy from the one download. Counted at the server,
				// through a proxy, so service worker, worker and HTTP cache traffic all show.
				const proxy = await countingProxy(running)
				const browser = await chromium.launch({ executablePath: chromiumPath() })
				const context = await browser.newContext()
				const page = await context.newPage()
				try {
					await page.goto(proxy.origin)
					await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible()
					// Installed means every precached file is in Cache Storage.
					await page.waitForFunction(
						() =>
							(globalThis as { __KORA_SHELL__?: { state?: string } }).__KORA_SHELL__?.state ===
							'installed',
						null,
						{ timeout: 60_000 },
					)
					const requests = proxy.requests()
					const html = readFileSync(join(built.distDir, 'index.html'), 'utf8')
					const entry = /<script type="module"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1]
					expect(entry).toBeDefined()
					const wasmPaths = readdirSync(join(built.distDir, 'assets'))
						.filter((name) => name.endsWith('.wasm'))
						.map((name) => `/assets/${name}`)
					expect(wasmPaths.length).toBeGreaterThan(0)
					const downloads = (paths: string[]) =>
						requests.filter((r) => r.method === 'GET' && r.status === 200 && paths.includes(r.path))
					const summary = requests
						.map((r) => `${r.method} ${r.path} ${r.status} ${r.bytes}B`)
						.join('\n')
					console.log(
						`[${spec.name}] cold first load: ${requests.length} requests, ${requests.reduce(
							(sum, r) => sum + r.bytes,
							0,
						)} body bytes\n${summary}`,
					)
					expect(downloads([entry ?? '']), summary).toHaveLength(1)
					// One download of the WASM bytes, under whichever name the runtime asked for.
					expect(downloads(wasmPaths), summary).toHaveLength(1)
					// No file is downloaded twice at all.
					const seen = new Set<string>()
					for (const r of requests.filter((r) => r.method === 'GET' && r.status === 200)) {
						expect(seen.has(r.path), `${r.path} downloaded twice\n${summary}`).toBe(false)
						seen.add(r.path)
					}
					// The worker (and so the precache) starts only after the page's WASM download ended.
					const worker = requests.find((r) => r.path === '/sw.js')
					const wasm = downloads(wasmPaths)[0]
					expect(worker && wasm && worker.startSeq > wasm.endSeq, summary).toBe(true)
				} finally {
					await context.close()
					await browser.close()
					await proxy.stop()
				}
			})

			test('with the service worker blocked the app is never reported ready', async () => {
				const browser = await chromium.launch({ executablePath: chromiumPath() })
				const context = await browser.newContext({ serviceWorkers: 'block' })
				const page = await context.newPage()
				try {
					const report = await expectNeverReady(page, async () => {
						await page.goto(running.origin)
						await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible()
						await addTodo(page, 'no shell')
					})
					expect(report.samples).toBeGreaterThan(0)
					expect(report.lastStatus).not.toBeNull()
					expect(report.reasonsSeen.some((r) => r.startsWith('shell-'))).toBe(true)
					report.assertNeverReady()
				} finally {
					await context.close()
					await browser.close()
				}
			})
		})
}
