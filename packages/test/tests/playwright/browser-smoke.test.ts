/**
 * One real-Chromium smoke test for `@korajs/test/playwright`.
 *
 * It serves a tiny static page with a service worker over http://127.0.0.1 and a stub
 * `window.app.offline` whose state is `ready` once the worker is active, then exercises the
 * helpers against it. Skipped cleanly when `playwright-core` or Chromium is not available.
 * Honors PW_CHROMIUM_PATH like the other browser repros in the repo. No sleeps: every wait is on
 * a condition.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserType } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	assertReadyMeansOffline,
	blockServiceWorker,
	expectNeverReady,
	firstVisitOffline,
	goOffline,
	goOnline,
	hasReason,
	killTab,
	openProfile,
	restartProfile,
	skewClock,
	throttleNetwork,
	waitForOfflineStatus,
} from '../../src/playwright'

const INDEX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>stub</title></head>
<body>
<div id="app">shell</div>
<ul id="notes"></ul>
<script>
const KEY = 'notes'
const read = () => JSON.parse(localStorage.getItem(KEY) || '["seed"]')
const render = () => {
  document.getElementById('notes').innerHTML = read().map((n) => '<li class="note">' + n + '</li>').join('')
}
window.addNote = (text) => {
  localStorage.setItem(KEY, JSON.stringify(read().concat(text)))
  render()
}
render()
let phase = 'installing'
window.app = {
  offline: {
    status() {
      if (phase === 'active') return { state: 'ready', reasons: [] }
      if (phase === 'failed') return { state: 'not-ready', reasons: ['shell-none'] }
      return { state: 'preparing', reasons: ['shell-installing'] }
    },
  },
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => { phase = 'active' })
    .catch(() => { phase = 'failed' })
} else {
  phase = 'failed'
}
</script>
</body></html>`

const SW_JS = `const CACHE = 'shell-v1'
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.put('/', new Response(${JSON.stringify(INDEX_HTML)}, { headers: { 'content-type': 'text/html' } }))).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(caches.match('/').then((hit) => hit || fetch(event.request)))
  }
})`

async function loadChromium(): Promise<BrowserType | null> {
	try {
		const playwright = await import('playwright-core')
		return playwright.chromium
	} catch {
		return null
	}
}

const launchOptions = {
	executablePath: process.env.PW_CHROMIUM_PATH || undefined,
	// Chromium refuses to start its sandbox as root, which is how CI containers run.
	args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
}

const chromium = await loadChromium()
let browser: Browser | null = null
if (chromium !== null && existsSync(launchOptions.executablePath ?? chromium.executablePath())) {
	try {
		browser = await chromium.launch(launchOptions)
	} catch {
		browser = null
	}
}

describe.skipIf(browser === null || chromium === null)(
	'@korajs/test/playwright in Chromium',
	() => {
		let server: Server
		let url: string
		let profileRoot: string

		beforeAll(async () => {
			server = createServer((req, res) => {
				const path = (req.url ?? '/').split('?')[0]
				if (path === '/sw.js') {
					res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
					res.end(SW_JS)
				} else if (path === '/online-only') {
					res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
					res.end('online')
				} else {
					res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
					res.end(INDEX_HTML)
				}
			})
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
			url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
			profileRoot = await mkdtemp(join(tmpdir(), 'kora-pw-profile-'))
		})

		afterAll(async () => {
			await browser?.close()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await rm(profileRoot, { recursive: true, force: true })
		})

		const fetchOnlineOnly = (page: import('playwright-core').Page): Promise<boolean> =>
			page.evaluate(() =>
				fetch('/online-only', { cache: 'no-store' }).then(
					(r) => r.ok,
					() => false,
				),
			)

		it('goOffline cuts the network but the service worker still serves the shell', async () => {
			const context = await browser?.newContext()
			if (!context) throw new Error('no browser')
			try {
				const page = await context.newPage()
				await page.goto(url)
				await waitForOfflineStatus(page, 'ready')
				expect(await fetchOnlineOnly(page)).toBe(true)

				await goOffline(page)
				expect(await fetchOnlineOnly(page)).toBe(false)
				await page.reload()
				await page.waitForSelector('#app')

				await goOnline(context)
				expect(await fetchOnlineOnly(page)).toBe(true)
			} finally {
				await context.close()
			}
		})

		it('assertReadyMeansOffline passes for an app that is really offline-ready', async () => {
			const context = await browser?.newContext()
			if (!context) throw new Error('no browser')
			try {
				const page = await context.newPage()
				await page.goto(url)
				const report = await assertReadyMeansOffline(page, {
					shellSelector: '#app',
					dataSelector: '.note',
					requireReadyAfterReload: true,
					write: async (p) => {
						await p.evaluate(() => {
							;(window as unknown as { addNote(t: string): void }).addNote('written offline')
						})
					},
					verifyWrite: async (p) =>
						(await p.locator('.note', { hasText: 'written offline' }).count()) > 0,
				})
				expect(report.readyStatus.state).toBe('ready')
				expect(report.steps).toContain('write survives reload')
				// The helper restored the network.
				expect(await fetchOnlineOnly(page)).toBe(true)
			} finally {
				await context.close()
			}
		})

		it('firstVisitOffline loads from the service worker, and a cold offline visit fails cleanly', async () => {
			const warmContext = await browser?.newContext()
			const coldContext = await browser?.newContext()
			if (!warmContext || !coldContext) throw new Error('no browser')
			try {
				const warm = await firstVisitOffline(warmContext, url, { waitForReady: true })
				expect(warm.loaded).toBe(true)
				await warm.page.waitForSelector('#app')

				const cold = await firstVisitOffline(coldContext, url, { warmUp: false })
				expect(cold.loaded).toBe(false)
				expect(cold.error).toMatch(/ERR_INTERNET_DISCONNECTED/)
			} finally {
				await warmContext.close()
				await coldContext.close()
			}
		})

		it('expectNeverReady sees a blocked service worker stay not ready, and catches ready when it happens', async () => {
			const blocked = await browser?.newContext()
			const normal = await browser?.newContext()
			if (!blocked || !normal) throw new Error('no browser')
			try {
				await blockServiceWorker(blocked)
				const blockedPage = await blocked.newPage()
				await blockedPage.goto(url)
				const negative = await expectNeverReady(blockedPage, async () => {
					await waitForOfflineStatus(blockedPage, hasReason('shell-none'))
					await blockedPage.reload()
					await waitForOfflineStatus(blockedPage, hasReason('shell-none'))
				})
				negative.assertNeverReady()
				expect(negative.everReady).toBe(false)
				expect(negative.reasonsSeen).toContain('shell-none')
				expect(negative.probeRead).toBe(true)

				// Control: the same observer must be able to fail.
				const normalPage = await normal.newPage()
				await normalPage.goto(url)
				const positive = await expectNeverReady(normalPage, async () => {
					await waitForOfflineStatus(normalPage, 'ready')
				})
				expect(positive.everReady).toBe(true)
				expect(() => positive.assertNeverReady()).toThrow(/must never be ready/)
			} finally {
				await blocked.close()
				await normal.close()
			}
		})

		it('throttleNetwork applies and resets CDP network conditions', async () => {
			const context = await browser?.newContext()
			if (!context) throw new Error('no browser')
			try {
				const page = await context.newPage()
				await page.goto(url)

				const slow = await throttleNetwork(page, 'slow-4g')
				expect(await fetchOnlineOnly(page)).toBe(true)
				await slow.reset()

				const cut = await throttleNetwork(page, 'offline')
				expect(await fetchOnlineOnly(page)).toBe(false)
				await cut.reset()
				expect(await fetchOnlineOnly(page)).toBe(true)
			} finally {
				await context.close()
			}
		})

		it('killTab crashes the renderer and the context keeps working', async () => {
			const context = await browser?.newContext()
			if (!context) throw new Error('no browser')
			try {
				const page = await context.newPage()
				await page.goto(url)
				await killTab(page)
				await expect(page.evaluate(() => 1)).rejects.toThrow()

				const reopened = await context.newPage()
				await reopened.goto(url)
				await waitForOfflineStatus(reopened, 'ready')
			} finally {
				await context.close()
			}
		})

		it('skewClock offsets Date.now() in the page, across reloads', async () => {
			const context = await browser?.newContext()
			if (!context) throw new Error('no browser')
			try {
				const page = await context.newPage()
				await page.goto(url)
				await skewClock(page, 3_600_000)
				for (const reload of [false, true]) {
					if (reload) await page.reload()
					const before = Date.now()
					const skewed = await page.evaluate(() => Date.now())
					const after = Date.now()
					expect(skewed).toBeGreaterThanOrEqual(before + 3_600_000)
					expect(skewed).toBeLessThanOrEqual(after + 3_600_000)
				}
			} finally {
				await context.close()
			}
		})

		it('restartProfile reopens the same user data directory', async () => {
			if (chromium === null) throw new Error('no chromium')
			const profile = await openProfile(chromium, join(profileRoot, 'profile'), launchOptions)
			try {
				const first = await profile.context.newPage()
				await first.goto(url)
				await first.evaluate(() => localStorage.setItem('survives', 'restart'))
				const oldContext = profile.context

				await restartProfile(profile)
				expect(profile.context).not.toBe(oldContext)

				const second = await profile.context.newPage()
				await second.goto(url)
				expect(await second.evaluate(() => localStorage.getItem('survives'))).toBe('restart')
			} finally {
				await profile.context.close()
			}
		})
	},
)
