// NEW-DX-3 repro: an app served by Kora's production server cannot be reopened offline,
// because nothing installs a service worker or caches the app shell.
// Correct behaviour: after one online visit, an offline reload renders the app shell.
// Today: page.reload fails with net::ERR_INTERNET_DISCONNECTED.
//
// Run (packages built): PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node packages/server/tests/repro/browser/NEW-DX-3.offline-shell.mjs
// Output lines follow the remediation checker format: PASS|FAIL [ID] description
//
// When the offline app shell lands, point STATIC_DIR at a scaffolded template build instead of the
// bare fixture below, so the test proves the real template works offline.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../../..')
const require = createRequire(join(repo, 'e2e/package.json'))
const { chromium } = require('@playwright/test')
const { createProductionServer, MemoryServerStore } = await import(
	join(repo, 'packages/server/dist/index.js')
)

const staticDir = process.env.STATIC_DIR ?? mkdtempSync(join(tmpdir(), 'kora-shell-'))
if (!process.env.STATIC_DIR) {
	mkdirSync(join(staticDir, 'assets'), { recursive: true })
	writeFileSync(
		join(staticDir, 'index.html'),
		'<!doctype html><html><head><script src="/assets/app-abc123.js"></script></head><body><h1 id="t">KORA APP SHELL</h1></body></html>',
	)
	writeFileSync(join(staticDir, 'assets/app-abc123.js'), 'document.title = "loaded"')
}

const port = 4700 + Math.floor(Math.random() * 200)
const server = createProductionServer({ store: new MemoryServerStore(), staticDir, port })
await server.start()
const browser = await chromium.launch({
	executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
})
let failed = 0
try {
	const ctx = await browser.newContext()
	const page = await ctx.newPage()
	await page.goto(`http://localhost:${port}/`)
	const online = await page.textContent('body')
	console.log(
		`${online?.includes('KORA APP SHELL') ? 'PASS' : 'FAIL'} [NEW-DX-3] control: app shell loads online`,
	)
	// Give a service worker (if any) a chance to install and take control.
	await page.waitForTimeout(1500)
	await ctx.setOffline(true)
	let offline = ''
	try {
		await page.reload({ timeout: 8000 })
		offline = (await page.textContent('body')) ?? ''
	} catch (error) {
		offline = `RELOAD FAILED: ${String(error).split('\n')[0]}`
	}
	const ok = offline.includes('KORA APP SHELL')
	if (!ok) failed++
	console.log(`${ok ? 'PASS' : 'FAIL'} [NEW-DX-3] app shell reopens offline after one online visit`)
	console.log(`       ${offline.slice(0, 140)}`)
} finally {
	await browser.close()
	await server.stop?.()
}
process.exit(failed ? 1 : 0)
