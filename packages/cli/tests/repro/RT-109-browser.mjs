// RT-109 browser repro (manual, not part of vitest): node RT-109-browser.mjs <app-dir>
// <app-dir>: an app scaffolded with create-kora-app (react-tailwind-sync), installed and
// buildable. PW_CHROMIUM_PATH=/opt/pw-browsers/chromium; port 3001 free. The script edits
// src/App.tsx and src/schema.ts and restores them.
// Deploy v1, open it (SW v1 installs), deploy v2 (schema version 2 + new title), reload
// online without accepting the update, then reload offline; then accept the update.
// Bug (beta.13 RC): the online reload ran v2 (prompt still shown) and the offline reload
// v1, against the database v2 had migrated.
// Correct: v1 online and offline until the update is accepted; then v2 online and offline.
// Prints each step and `RT-109 browser: PASS` (exit 0) or `FAIL` (exit 1).
import { execSync, spawn } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const repoRoot = new URL('../../../../', import.meta.url).pathname
const pwDir = readdirSync(`${repoRoot}node_modules/.pnpm`).find((d) =>
	d.startsWith('playwright-core@'),
)
const require = createRequire(
	`${repoRoot}node_modules/.pnpm/${pwDir}/node_modules/playwright-core/package.json`,
)
const { chromium } = require('playwright-core')
const app = process.argv[2]
const url = 'http://localhost:3001/'
const sh = (cmd) => execSync(cmd, { cwd: app, stdio: 'pipe' }).toString()
const appTsx = `${app}/src/App.tsx`
const schemaTs = `${app}/src/schema.ts`
const origApp = readFileSync(appTsx, 'utf8')
const origSchema = readFileSync(schemaTs, 'utf8')
writeFileSync(appTsx, origApp.replace('>My Tasks<', '>My Tasks v1<'))
sh('pnpm build')
const server = spawn('node', ['--import', 'tsx', 'server.ts'], {
	cwd: app,
	env: { ...process.env, PORT: '3001', KORA_SERVER_DB: `${app}/.kora/rt109-${Date.now()}.db` },
	stdio: 'ignore',
})
await new Promise((r) => setTimeout(r, 5000))
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH })
const context = await browser.newContext()
const page = await context.newPage()
const title = () => page.locator('h1').first().textContent()
const failures = []
const expectStep = (label, actual, expected) => {
	const ok = actual === expected
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`)
	if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}`)
}
const input = 'input[placeholder="What needs to be done?"]'
const add = async (text) => {
	await page.fill(input, text)
	await page.press(input, 'Enter')
	await page.waitForSelector(`text=${text}`, { timeout: 15000 })
}
const registration = () =>
	page.evaluate(async () => {
		const r = await navigator.serviceWorker.getRegistration()
		return { active: !!r?.active, waiting: !!r?.waiting }
	})
try {
	await page.goto(url, { waitUntil: 'load' })
	await page.waitForSelector('h1')
	await page.evaluate(() => navigator.serviceWorker.ready)
	await page.reload({ waitUntil: 'load' })
	await page.waitForSelector('h1')
	expectStep('v1 online', await title(), 'My Tasks v1')
	expectStep('controlled', await page.evaluate(() => !!navigator.serviceWorker.controller), true)
	await add('made by v1')

	// Deploy v2: new title and schema version 2.
	writeFileSync(appTsx, origApp.replace('>My Tasks<', '>My Tasks v2<'))
	writeFileSync(schemaTs, origSchema.replace('version: 1', 'version: 2'))
	sh('pnpm build')
	await page.reload({ waitUntil: 'load' })
	await page.waitForSelector('h1')
	await page.waitForSelector('#kora-update-prompt', { timeout: 30000 }).catch(() => undefined)
	expectStep('after deploy, online reload (update NOT accepted)', await title(), 'My Tasks v1')
	expectStep('update prompt shown', await page.locator('#kora-update-prompt').count(), 1)
	expectStep('registration', JSON.stringify(await registration()), '{"active":true,"waiting":true}')
	await add('made online before accepting')

	await context.setOffline(true)
	await page.reload({ waitUntil: 'load' })
	await page.waitForSelector('h1', { timeout: 30000 })
	expectStep('offline reload (update NOT accepted)', await title(), 'My Tasks v1')
	await add('made by v1 offline')

	// Accept the update online: the new worker activates and the page reloads into v2.
	await context.setOffline(false)
	await page.reload({ waitUntil: 'load' })
	await page.waitForSelector('#kora-update-prompt button', { timeout: 30000 })
	await Promise.all([
		page.waitForEvent('load', { timeout: 30000 }),
		page.click('#kora-update-prompt button'),
	])
	await page.waitForSelector('h1')
	await page
		.waitForFunction(() => document.querySelector('h1')?.textContent === 'My Tasks v2', undefined, {
			timeout: 30000,
		})
		.catch(() => undefined)
	expectStep('after accepting the update', await title(), 'My Tasks v2')
	await page.waitForSelector('text=made by v1 offline', { timeout: 15000 }).catch(() => undefined)
	expectStep('v2 sees the v1 writes', await page.locator('text=made by v1 offline').count(), 1)

	await context.setOffline(true)
	await page.reload({ waitUntil: 'load' })
	await page.waitForSelector('h1', { timeout: 30000 })
	expectStep('offline reload after the update', await title(), 'My Tasks v2')
	await add('made by v2 offline')
	const after = await page.evaluate(async () => {
		const r = await navigator.serviceWorker.getRegistration()
		return { active: !!r?.active, waiting: !!r?.waiting }
	})
	console.log('registration after update:', JSON.stringify(after))
} catch (e) {
	failures.push(`error: ${e.message}`)
	console.log('ERROR', e.message)
} finally {
	await browser.close()
	server.kill()
	writeFileSync(appTsx, origApp)
	writeFileSync(schemaTs, origSchema)
}
console.log(
	failures.length === 0 ? 'RT-109 browser: PASS' : `RT-109 browser: FAIL\n${failures.join('\n')}`,
)
process.exit(failures.length === 0 ? 0 : 1)
