// NEW-DX-3 repro: a scaffolded Kora app must open offline.
//
// Scaffolds the real react-basic template with the built CLI, builds it with Vite (the
// template's own vite.config.ts, including koraServiceWorker()), serves dist/ with Kora's
// createProductionServer and drives it in real Chromium:
//   load online, write data, go offline AND stop the server, reload, cold-start a new tab,
//   write data offline; then ship a new build and check the "new version available" flow.
// Before the fix nothing installed a service worker, so the offline reload failed with
// net::ERR_INTERNET_DISCONNECTED.
//
// Run (packages built): PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node packages/server/tests/repro/browser/NEW-DX-3.offline-shell.mjs
// Output lines follow the remediation checker format: PASS|FAIL [ID] description
// STATIC_DIR=<dist> skips scaffolding and serves that build instead (shell checks only).
import { execFileSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../../..')
const require = createRequire(join(repo, 'e2e/package.json'))
const { chromium } = require('@playwright/test')
const { createProductionServer, MemoryServerStore } = await import(
	join(repo, 'packages/server/dist/index.js')
)

let failed = 0
function check(ok, description, detail = '') {
	if (!ok) failed++
	console.log(`${ok ? 'PASS' : 'FAIL'} [NEW-DX-3] ${description}`)
	if (detail) console.log(`       ${String(detail).slice(0, 200)}`)
}

// ---------------------------------------------------------------- scaffold + build
const work = mkdtempSync(join(tmpdir(), 'kora-shell-'))
const appDir = join(work, 'shell-app')
let staticDir = process.env.STATIC_DIR
const fixtureModules = join(repo, 'e2e/fixture-app/node_modules')

async function viteBuild() {
	const vite = await import(pathToFileURL(join(fixtureModules, 'vite/dist/node/index.js')).href)
	const cwd = process.cwd()
	// The template's sqlite copy step resolves dist/ and node_modules/ against the cwd.
	process.chdir(appDir)
	try {
		await vite.build({
			root: appDir,
			logLevel: 'error',
			configFile: join(appDir, 'vite.config.ts'),
		})
	} finally {
		process.chdir(cwd)
	}
}

if (!staticDir) {
	execFileSync(
		process.execPath,
		[
			join(repo, 'packages/cli/dist/create.js'),
			'shell-app',
			'--template',
			'react-basic',
			'--skip-install',
			'--yes',
			'--platform',
			'web',
			'--framework',
			'react',
			'--no-sync',
			'--no-tailwind',
		],
		{ cwd: work, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'test' } },
	)
	// Link the workspace's installed packages instead of installing from the registry: the
	// e2e fixture app has every dependency react-basic needs, @korajs/cli is this checkout.
	const modules = join(appDir, 'node_modules')
	mkdirSync(join(modules, '@korajs'), { recursive: true })
	for (const entry of readdirSync(fixtureModules)) {
		if (entry === '@korajs' || entry.startsWith('.')) continue
		symlinkSync(join(fixtureModules, entry), join(modules, entry))
	}
	for (const entry of readdirSync(join(fixtureModules, '@korajs'))) {
		symlinkSync(join(fixtureModules, '@korajs', entry), join(modules, '@korajs', entry))
	}
	symlinkSync(join(repo, 'packages/cli'), join(modules, '@korajs/cli'))
	await viteBuild()
	staticDir = join(appDir, 'dist')
}

const html = readFileSync(join(staticDir, 'index.html'), 'utf8')
if (!process.env.STATIC_DIR) {
	check(existsSync(join(staticDir, 'sw.js')), 'template build emits sw.js')
	check(
		/serviceWorker[\s\S]*register\(/.test(html),
		'built index.html registers the service worker',
	)
}

// ---------------------------------------------------------------- browser
const port = 4700 + Math.floor(Math.random() * 200)
let server = createProductionServer({ store: new MemoryServerStore(), staticDir, port })
await server.start()
const browser = await chromium.launch({
	executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
})
const origin = `http://localhost:${port}`
const marker = process.env.STATIC_DIR ? 'KORA APP SHELL' : 'My Tasks'
const text = async (page) => (await page.textContent('body').catch(() => '')) ?? ''

async function addTodo(page, title) {
	await page.fill('input[placeholder="What needs to be done?"]', title)
	await page.click('button[type="submit"]')
	await page.getByText(title).waitFor({ timeout: 10_000 })
}

try {
	const ctx = await browser.newContext()
	let page = await ctx.newPage()
	await page.goto(`${origin}/`)
	await page.getByText(marker).first().waitFor({ timeout: 30_000 })
	check((await text(page)).includes(marker), 'control: app shell loads online')

	const online = `online-${Date.now().toString(36)}`
	if (!process.env.STATIC_DIR) await addTodo(page, online)

	// Wait until a service worker controls the page (bounded; a missing worker fails below).
	await page
		.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15_000 })
		.catch(() => {})
	const caches = await page.evaluate(async () =>
		'caches' in self
			? Promise.all(
					(await caches.keys()).map(async (k) => ({
						k,
						urls: (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname),
					})),
				)
			: [],
	)
	const cached = caches.flatMap((c) => c.urls)
	if (!process.env.STATIC_DIR) {
		check(
			cached.includes('/index.html') && cached.some((u) => /\/assets\/.+\.js$/.test(u)),
			'shell and hashed assets are precached',
			cached.join(' '),
		)
		check(
			!cached.some((u) => u.startsWith('/kora-sync') || u.startsWith('/auth')),
			'sync endpoint and auth routes are never cached',
		)
	}

	// Offline: no network AND no server at all, so nothing can come from anywhere but the cache.
	await ctx.setOffline(true)
	await server.stop()
	let offline = ''
	try {
		await page.reload({ timeout: 15_000 })
		await page.getByText(marker).first().waitFor({ timeout: 20_000 })
		offline = await text(page)
	} catch (error) {
		offline = `RELOAD FAILED: ${String(error).split('\n')[0]}`
	}
	check(
		offline.includes(marker),
		'app shell reopens offline after one online visit',
		offline.slice(0, 140),
	)

	if (!process.env.STATIC_DIR) {
		const dataOk = await page
			.getByText(online)
			.waitFor({ timeout: 15_000 })
			.then(() => true)
			.catch(() => false)
		check(dataOk, 'local data written online is readable after the offline reload')

		// Cold start: a brand-new tab, offline, server down.
		await page.close()
		page = await ctx.newPage()
		let cold = ''
		try {
			await page.goto(`${origin}/`, { timeout: 15_000 })
			await page.getByText(online).waitFor({ timeout: 20_000 })
			cold = await text(page)
		} catch (error) {
			cold = `COLD START FAILED: ${String(error).split('\n')[0]}`
		}
		check(
			cold.includes(online),
			'cold start offline opens the app with its local data',
			cold.slice(0, 140),
		)

		const offlineTodo = `offline-${Date.now().toString(36)}`
		const wrote = await addTodo(page, offlineTodo)
			.then(() => true)
			.catch(() => false)
		check(wrote, 'writes work offline')

		// ------------------------------------------------------------ update flow
		writeFileSync(
			join(appDir, 'src/App.tsx'),
			readFileSync(join(appDir, 'src/App.tsx'), 'utf8').replace('My Tasks', 'My Tasks v2'),
		)
		await viteBuild()
		server = createProductionServer({ store: new MemoryServerStore(), staticDir, port })
		await server.start()
		await ctx.setOffline(false)
		await page.reload()
		await page.getByText('My Tasks').first().waitFor({ timeout: 30_000 })
		const prompted = await page
			.locator('#kora-update-prompt')
			.waitFor({ timeout: 20_000 })
			.then(() => true)
			.catch(() => false)
		check(prompted, 'a new build shows the "new version available" prompt')
		if (prompted) {
			const oldCache = caches[0]?.k
			await Promise.all([
				page.waitForEvent('load', { timeout: 20_000 }),
				page.click('#kora-update-prompt button'),
			])
			await page.getByText('My Tasks v2').waitFor({ timeout: 20_000 })
			const after = await page.evaluate(() => caches.keys())
			check(
				after.length === 1 && after[0] !== oldCache,
				'accepting the update reloads into the new version and drops the old cache',
				`${oldCache} -> ${after}`,
			)
			const kept = await page
				.getByText(offlineTodo)
				.waitFor({ timeout: 15_000 })
				.then(() => true)
				.catch(() => false)
			check(kept, 'local data survives the update')
		}
	}
} finally {
	await browser.close()
	await server.stop?.().catch?.(() => {})
	if (!process.env.KEEP_SHELL_APP) rmSync(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
