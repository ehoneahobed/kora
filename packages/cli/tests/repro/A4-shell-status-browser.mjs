// A4 browser check (manual, not part of vitest): node packages/cli/tests/repro/A4-shell-status-browser.mjs
//
// The offline shell status protocol (offline-readiness design, section 7) in real Chromium,
// against a tiny static site built with the real `koraServiceWorker()` plugin (needs
// `pnpm --filter @korajs/cli build`). The site's server can "go offline" (it destroys every
// connection) and can serve a NEWER deployment at the mutable URLs.
//
// Checks: installed after the first load; an entry deleted from Cache Storage reads
// not-installed while offline and heals (installed) once online with the build's own bytes;
// a lost index.html is NOT healed from a newer deployment's bytes (stays not-installed, the
// newer bytes never enter the cache) and heals again once the server serves this build;
// a page that runs a hashed script this build does not hold reads other-build.
//
// Skips cleanly (exit 0, "SKIP") when Chromium, Playwright or the CLI build is missing.
// PW_CHROMIUM_PATH overrides the browser path. Never installs a browser.
// Output follows the remediation format: PASS|FAIL [A4] description.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../../..')
const skip = (reason) => {
	console.log(`SKIP [A4] ${reason}`)
	process.exit(0)
}

const cliVite = join(repo, 'packages/cli/dist/vite.js')
if (!existsSync(cliVite))
	skip('packages/cli/dist/vite.js is missing (pnpm --filter @korajs/cli build)')
const executablePath = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium'
if (!existsSync(executablePath)) skip(`no Chromium at ${executablePath} (set PW_CHROMIUM_PATH)`)

let chromium
try {
	const pnpmDir = join(repo, 'node_modules/.pnpm')
	const pw = readdirSync(pnpmDir).find((d) => d.startsWith('playwright-core@'))
	if (!pw) throw new Error('playwright-core is not installed')
	chromium = createRequire(join(pnpmDir, pw, 'node_modules/playwright-core/package.json'))(
		'playwright-core',
	).chromium
} catch (error) {
	skip(`Playwright is unavailable: ${error.message}`)
}
const { koraServiceWorker } = await import(pathToFileURL(cliVite).href)

// ------------------------------------------------------------------ build the site
const work = mkdtempSync(join(tmpdir(), 'kora-a4-'))
const dist = join(work, 'dist')
mkdirSync(join(dist, 'assets'), { recursive: true })
const indexSource = (marker) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>A4 ${marker}</title><link rel="stylesheet" href="/assets/app-Ab12Cd34.css"></head><body><main id="app">shell</main><script type="module" src="/assets/app-Ab12Cd34.js"></script></body></html>`
writeFileSync(join(dist, 'assets/app-Ab12Cd34.js'), 'window.__app = "v1"\n')
writeFileSync(join(dist, 'assets/app-Ab12Cd34.css'), 'body { margin: 0 }\n')

const plugin = koraServiceWorker({ buildId: false })
plugin.configResolved({ root: work, base: '/', command: 'build', build: { outDir: 'dist' } })
const transformed = plugin.transformIndexHtml(indexSource('v1'))
let html = transformed.html
for (const tag of transformed.tags) {
	const attrs = Object.entries(tag.attrs ?? {})
		.map(([key, value]) => (value === true ? key : `${key}="${value}"`))
		.join(' ')
	const element = `<${tag.tag}${attrs ? ` ${attrs}` : ''}>${tag.children ?? ''}</${tag.tag}>`
	html =
		tag.injectTo === 'head-prepend'
			? html.replace('<head>', `<head>${element}`)
			: html.replace('</body>', `${element}</body>`)
}
writeFileSync(join(dist, 'index.html'), html)
plugin.closeBundle.handler()
// Another deployment's script: on the server, but not in this build's precache.
writeFileSync(join(dist, 'assets/other-Zz99Yy88.js'), 'window.__other = true\n')

// ------------------------------------------------------------------ server
let down = false
let newer = false
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer((req, res) => {
	if (down) {
		req.socket.destroy()
		return
	}
	const path = new URL(req.url ?? '/', 'http://x').pathname
	const file = join(dist, path === '/' ? 'index.html' : path)
	if (!existsSync(file) || !file.startsWith(dist)) {
		res.writeHead(404).end('not found')
		return
	}
	let body = readFileSync(file)
	// A newer deployment: the mutable index.html now has different bytes.
	if (newer && path === '/index.html') body = Buffer.from(`${body}<!-- deployment 2 -->`)
	res.writeHead(200, {
		'content-type': types[extname(file)] ?? 'application/octet-stream',
		'cache-control': 'no-store',
	})
	res.end(body)
})
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const origin = `http://localhost:${server.address().port}`

// ------------------------------------------------------------------ checks
let failed = 0
const check = (ok, description, detail = '') => {
	if (!ok) failed++
	console.log(`${ok ? 'PASS' : 'FAIL'} [A4] ${description}`)
	if (!ok && detail) console.log(`       ${String(detail).slice(0, 300)}`)
}

const browser = await chromium.launch({ executablePath })
try {
	const context = await browser.newContext()
	const page = await context.newPage()
	const shell = () => page.evaluate(() => globalThis.__KORA_SHELL__ ?? null)
	const waitState = (state) =>
		page.waitForFunction((want) => globalThis.__KORA_SHELL__?.state === want, state, {
			timeout: 30_000,
		})
	// What the page does on its own at visibilitychange: another check of the shell.
	const recheck = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
	const cached = (url) =>
		page.evaluate(async (u) => {
			for (const key of await caches.keys()) {
				if (key.startsWith('kora-shell-') && (await (await caches.open(key)).match(u))) return true
			}
			return false
		}, url)
	const dropFromCache = (url) =>
		page.evaluate(async (u) => {
			for (const key of await caches.keys()) {
				if (key.startsWith('kora-shell-')) await (await caches.open(key)).delete(u)
			}
		}, url)

	await page.goto(`${origin}/`)
	await waitState('installed')
	const first = await shell()
	check(
		first?.v === 1 && /^[0-9a-f]{16}$/.test(first.version ?? ''),
		'installed after the first load, with the build version',
		JSON.stringify(first),
	)

	// An entry vanishes; offline there is nothing to heal with.
	down = true
	await dropFromCache('/assets/app-Ab12Cd34.css')
	await recheck()
	await waitState('not-installed')
	check(true, 'a deleted precache entry reads not-installed while offline')

	// Online again: the worker refetches it and stores it because the digest matches.
	down = false
	await recheck()
	await waitState('installed')
	check(
		await cached('/assets/app-Ab12Cd34.css'),
		"online, the entry is healed with the build's own bytes",
	)

	// index.html lost while a newer deployment serves different bytes there.
	newer = true
	await dropFromCache('/index.html')
	await recheck()
	await waitState('not-installed')
	check(
		!(await cached('/index.html')),
		'newer-deployment bytes are never stored (the entry stays missing)',
	)
	check(
		(await shell())?.state === 'not-installed',
		'the shell stays not-installed until the newer worker takes over',
	)

	// The server serves this build again: the next check heals it.
	newer = false
	await recheck()
	await waitState('installed')
	check(
		await cached('/index.html'),
		'once the server serves this build again, index.html is healed',
	)

	// A page running a hashed script the active worker does not hold (shift-reload online
	// during a deployment) cannot be reopened offline by this worker's build.
	await page.evaluate(
		() =>
			new Promise((resolveLoad, rejectLoad) => {
				const script = document.createElement('script')
				script.src = '/assets/other-Zz99Yy88.js'
				script.onload = resolveLoad
				script.onerror = rejectLoad
				document.head.append(script)
			}),
	)
	await recheck()
	await waitState('other-build')
	check(true, 'a hashed script from another build reads other-build')
} catch (error) {
	failed++
	console.log(`FAIL [A4] unexpected error: ${error.stack ?? error}`)
} finally {
	await browser.close()
	server.close()
	rmSync(work, { recursive: true, force: true })
}
console.log(failed === 0 ? 'A4 browser: PASS' : `A4 browser: FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
