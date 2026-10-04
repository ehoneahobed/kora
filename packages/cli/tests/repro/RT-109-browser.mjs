// RT-109 browser repro (manual, not part of vitest): node RT-109-browser.mjs <app-dir>
// <app-dir>: an app scaffolded with create-kora-app (react-tailwind-sync), installed and
// buildable. PW_CHROMIUM_PATH=/opt/pw-browsers/chromium; port 3001 free. The script edits
// src/App.tsx and src/schema.ts and restores them.
// Deploy v1, open it (SW v1 installs), deploy v2 (schema version 2 + new title), reload
// online without accepting the update, then reload offline.
// Bug: the online reload prints v2 (prompt still shown), the offline reload prints v1.
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
try {
	await page.goto(url, { waitUntil: 'load' })
	await page.waitForSelector('h1')
	await page.evaluate(() => navigator.serviceWorker.ready)
	await page.reload({ waitUntil: 'load' })
	await page.waitForSelector('h1')
	console.log(
		'v1 online:',
		await title(),
		'controlled:',
		await page.evaluate(() => !!navigator.serviceWorker.controller),
	)

	// Deploy v2: new title and schema version 2 (a new optional field).
	writeFileSync(appTsx, origApp.replace('>My Tasks<', '>My Tasks v2<'))
	writeFileSync(schemaTs, origSchema.replace('version: 1', 'version: 2'))
	sh('pnpm build')
	await page.reload({ waitUntil: 'load' })
	await page.waitForSelector('h1')
	await page.waitForTimeout(3000)
	const prompt = await page.locator('#kora-update-prompt').count()
	console.log(
		'after deploy, online reload (update NOT accepted):',
		await title(),
		'prompt shown:',
		prompt,
	)
	await page.fill('input[placeholder="What needs to be done?"]', 'made by v2')
	await page.press('input[placeholder="What needs to be done?"]', 'Enter')
	await page.waitForSelector('text=made by v2')
	const regState = await page.evaluate(async () => {
		const r = await navigator.serviceWorker.getRegistration()
		return { active: !!r?.active, waiting: !!r?.waiting }
	})
	console.log('registration:', JSON.stringify(regState))

	await context.setOffline(true)
	await page.reload({ waitUntil: 'load' })
	await page.waitForSelector('h1', { timeout: 30000 })
	await page.waitForTimeout(2000)
	console.log(
		'offline reload:',
		await title(),
		'sees v2 todo:',
		await page.locator('text=made by v2').count(),
	)
	await page.fill('input[placeholder="What needs to be done?"]', 'made by v1 offline')
	await page.press('input[placeholder="What needs to be done?"]', 'Enter')
	await page.waitForTimeout(1500)
	console.log('v1 offline write shown:', await page.locator('text=made by v1 offline').count())
	const errors = await page.evaluate(() => document.body.innerText.slice(0, 300))
	console.log('offline page text:', JSON.stringify(errors))
} catch (e) {
	console.log('ERROR', e.message)
} finally {
	await browser.close()
	server.kill()
	writeFileSync(appTsx, origApp)
	writeFileSync(schemaTs, origSchema)
}
