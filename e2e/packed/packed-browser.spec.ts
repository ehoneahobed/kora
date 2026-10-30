import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goOffline, goOnline, openProfile, readOfflineStatus } from '@korajs/test/playwright'
import type { Profile } from '@korajs/test/playwright'
import { type Page, chromium, expect, test } from '@playwright/test'
import {
	type RunningApp,
	type ScaffoldedApp,
	freePort,
	packWorkspace,
	scaffoldInstallBuild,
	serveApp,
} from '../offline/harness'
import { TEMPLATE_SPECS } from '../offline/templates'

/**
 * Browser scenarios on apps scaffolded and installed from the PACKED tarballs (the release
 * matrix, check `browser-app`). Two scenarios:
 *
 *   1. Auth-bound namespacing on the sync template with `store.namespaceByAuthUser`: two
 *      accounts in one browser profile never see each other's rows; an offline write survives a
 *      refresh and uploads on reconnect.
 *   2. Worker and WASM loading from a non-root base path (`vite build --base=/kora-base/`):
 *      every worker and WASM request resolves under the base, the service worker scopes to it,
 *      and the database is durable (no IndexedDB fallback).
 *
 * Nothing waits on a timer: each step waits on a status, a selector or a response.
 */

const TODO_PLACEHOLDER = 'What needs to be done?'
const PASSWORD = 'correct-horse-battery-staple-9'
const BASE = '/kora-base/'

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

function specOf(name: string) {
	const spec = TEMPLATE_SPECS.find((t) => t.name === name)
	if (!spec) throw new Error(`no template spec ${name}`)
	return spec
}

async function addTodo(page: Page, title: string): Promise<void> {
	const input = page.getByPlaceholder(TODO_PLACEHOLDER)
	await input.fill(title)
	await input.press('Enter')
	await page.getByText(title, { exact: true }).first().waitFor({ state: 'visible' })
}

interface PageApp {
	app: { sync: { status: { status: string; pendingOperations: number } } }
	authClient: {
		signUp(p: { email: string; password: string }): Promise<unknown>
		signIn(p: { email: string; password: string }): Promise<unknown>
		signOut(): Promise<void>
	}
}

/** Waits until the page's app has uploaded everything and reports `synced`. */
async function waitSynced(page: Page): Promise<void> {
	await page.waitForFunction(
		() => {
			const status = (globalThis as unknown as PageApp).app?.sync?.status
			return status?.status === 'synced' && status.pendingOperations === 0
		},
		undefined,
		{ timeout: 60_000 },
	)
}

async function authAction(page: Page, action: 'signUp' | 'signIn', email: string): Promise<void> {
	await page.evaluate(
		({ action: method, email: address, password }) =>
			(globalThis as unknown as PageApp).authClient[method]({ email: address, password }),
		{ action, email, password: PASSWORD },
	)
}

async function totalOperations(origin: string): Promise<number> {
	const health = (await (await fetch(`${origin}/health`)).json()) as { totalOperations: number }
	return health.totalOperations
}

/** Turns on database namespacing by signed-in user: the one option this scenario adds. */
function namespaceByUser(dir: string): void {
	const file = join(dir, 'src', 'kora.ts')
	const source = readFileSync(file, 'utf8')
	if (!source.includes('workerUrl: koraWorkerUrl')) {
		throw new Error('the template no longer configures store.workerUrl in src/kora.ts')
	}
	// exposeAppOnWindow has already renamed createApp in this file; the store block is untouched.
	writeFileSync(
		file,
		source.replace(
			'workerUrl: koraWorkerUrl',
			'namespaceByAuthUser: true,\n\t\tworkerUrl: koraWorkerUrl',
		),
	)
}

test.describe
	.serial('auth-bound namespacing, offline write, refresh and reconnect (sync template, packed)', () => {
		let built: ScaffoldedApp
		let running: RunningApp
		let profile: Profile
		let profileDir: string
		const alice = `alice-${Date.now()}@example.test`
		const bob = `bob-${Date.now()}@example.test`

		test.beforeAll(async () => {
			test.setTimeout(15 * 60_000)
			built = scaffoldInstallBuild(
				specOf('react-tailwind-sync'),
				packWorkspace(),
				(line) => console.log(`[namespacing] ${line}`),
				{ dirName: 'react-tailwind-sync-namespaced', patch: namespaceByUser },
			)
			running = await serveApp(built)
			profileDir = mkdtempSync(join(tmpdir(), 'kora-packed-profile-'))
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

		test('alice: sign up, write, go offline, write, refresh offline, reconnect uploads', async () => {
			const page = await profile.context.newPage()
			await page.goto(running.origin)
			await authAction(page, 'signUp', alice)
			// The database is chosen when the app starts; reload so it opens as alice's.
			await page.reload()
			await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible()
			await addTodo(page, 'alice online')
			await waitSynced(page)
			const before = await totalOperations(running.origin)

			await goOffline(page)
			await addTodo(page, 'alice offline')
			await page.reload()
			await page.getByText('alice offline', { exact: true }).first().waitFor({ state: 'visible' })
			await page.getByText('alice online', { exact: true }).first().waitFor({ state: 'visible' })
			expect(await totalOperations(running.origin)).toBe(before)

			await goOnline(page)
			await waitSynced(page)
			expect(await totalOperations(running.origin)).toBeGreaterThan(before)
			await page.close()
		})

		test("bob in the same profile never sees alice's rows; alice's come back for alice", async () => {
			const page = await profile.context.newPage()
			await page.goto(running.origin)
			await page.evaluate(() => (globalThis as unknown as PageApp).authClient.signOut())
			await authAction(page, 'signUp', bob)
			// Offline, so nothing can sync into bob's database: the template shares todos between
			// accounts on the server (it declares no access rules), and what is asserted here is
			// the PHYSICAL isolation of the two local databases.
			await goOffline(page)
			await page.reload()
			await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible()
			await expect(page.getByText('alice online', { exact: true })).toHaveCount(0)
			await expect(page.getByText('alice offline', { exact: true })).toHaveCount(0)
			await addTodo(page, 'bob only')

			await goOnline(page)
			await page.evaluate(() => (globalThis as unknown as PageApp).authClient.signOut())
			await authAction(page, 'signIn', alice)
			await goOffline(page)
			await page.reload()
			await page.getByText('alice offline', { exact: true }).first().waitFor({ state: 'visible' })
			await page.getByText('alice online', { exact: true }).first().waitFor({ state: 'visible' })
			await expect(page.getByText('bob only', { exact: true })).toHaveCount(0)
			const status = await readOfflineStatus(page)
			expect(status?.storage).toMatchObject({ durable: true })
			await goOnline(page)
			await page.close()
		})
	})

test.describe
	.serial('worker and WASM load from a non-root base path (local template, packed)', () => {
		let built: ScaffoldedApp
		let preview: { stop(): Promise<void> }
		let origin = ''
		let profile: Profile
		let profileDir: string

		test.beforeAll(async () => {
			test.setTimeout(15 * 60_000)
			built = scaffoldInstallBuild(
				specOf('react-basic'),
				packWorkspace(),
				(line) => console.log(`[base-path] ${line}`),
				{ dirName: 'react-basic-base', buildArgs: [`--base=${BASE}`] },
			)
			const port = await freePort()
			const child = spawn(
				join(built.dir, 'node_modules', '.bin', 'vite'),
				['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--base', BASE],
				{ cwd: built.dir, env: { ...process.env, NODE_ENV: 'production' } },
			)
			let output = ''
			child.stdout?.on('data', (chunk: Buffer) => {
				output += chunk.toString()
			})
			child.stderr?.on('data', (chunk: Buffer) => {
				output += chunk.toString()
			})
			origin = `http://127.0.0.1:${port}`
			await new Promise<void>((resolveReady, reject) => {
				const deadline = setTimeout(
					() => reject(new Error(`vite preview not ready:\n${output}`)),
					60_000,
				)
				const check = (): void => {
					// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
					const plain = output.replace(/\u001b\[[0-9;]*m/g, '')
					if (/127\.0\.0\.1:\d+/.test(plain)) {
						clearTimeout(deadline)
						resolveReady()
					}
				}
				child.stdout?.on('data', check)
				child.once('exit', (code) => {
					clearTimeout(deadline)
					reject(new Error(`vite preview exited ${code}:\n${output}`))
				})
				check()
			})
			preview = {
				stop: () =>
					new Promise<void>((resolveStop) => {
						if (child.exitCode !== null) return resolveStop()
						child.once('exit', () => resolveStop())
						child.kill('SIGTERM')
					}),
			}
			profileDir = mkdtempSync(join(tmpdir(), 'kora-packed-base-profile-'))
			profile = await openProfile(chromium, profileDir, {
				headless: true,
				executablePath: chromiumPath(),
			})
		})

		test.afterAll(async () => {
			await profile?.context.close().catch(() => {})
			await preview?.stop().catch(() => {})
			if (profileDir) rmSync(profileDir, { recursive: true, force: true })
		})

		test('the built app references everything under the base path', async () => {
			const html = readFileSync(join(built.distDir, 'index.html'), 'utf8')
			const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '')
			const local = refs.filter((ref) => ref.startsWith('/'))
			expect(local.length).toBeGreaterThan(0)
			expect(local.filter((ref) => !ref.startsWith(BASE))).toEqual([])
		})

		test('worker and WASM requests succeed under the base; the service worker scopes to it; storage is durable', async () => {
			const page = await profile.context.newPage()
			const failures: string[] = []
			const fetched: { url: string; status: number; type: string }[] = []
			page.on('response', (response) => {
				const url = new URL(response.url())
				const type = response.headers()['content-type'] ?? ''
				fetched.push({ url: url.pathname, status: response.status(), type })
				if (response.status() >= 400) failures.push(`${response.status()} ${url.pathname}`)
			})
			const errors: string[] = []
			page.on('pageerror', (error) => errors.push(error.message))
			await page.goto(`${origin}${BASE}`)
			await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible()
			await addTodo(page, 'durable under a base path')
			await page.reload()
			await page
				.getByText('durable under a base path', { exact: true })
				.first()
				.waitFor({ state: 'visible' })

			const wasm = fetched.filter((f) => f.url.endsWith('.wasm'))
			expect(wasm.length).toBeGreaterThan(0)
			for (const request of wasm) {
				expect(request.url.startsWith(BASE)).toBe(true)
				expect(request.type).toContain('application/wasm')
			}
			expect(failures).toEqual([])
			expect(errors).toEqual([])
			const scope = await page.evaluate(async () => {
				const registration = await navigator.serviceWorker.getRegistration()
				return registration?.scope ?? null
			})
			expect(scope).not.toBeNull()
			expect(new URL(scope ?? 'http://invalid').pathname).toBe(BASE)
			const status = await readOfflineStatus(page)
			expect(status?.storage).toMatchObject({ durable: true })
			await page.close()
		})
	})
