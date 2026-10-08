#!/usr/bin/env node
/**
 * Real-browser upgrade of a SCAFFOLDED beta.12 sync app to this branch, with no
 * node-binding script (F1, automatic device handover). Complements
 * `compat-beta12-auth-browser.mjs`, which wires the template's client by hand: this one
 * runs the app `create-kora-app` generated, built by its own `tsc && vite build`, and
 * served by its own `server.ts`.
 *
 * For each database (SQLite files, and Postgres when KORA_PG_TEST_URL is set):
 *
 * 1. beta.12's CLI scaffolds `react-tailwind-sync`. App-side edits: the auth
 *    server gets a PERSISTENT user store (`createSqliteUserStore` /
 *    `createPostgresUserStore`), and `src/auth.ts` exposes its `authClient` on
 *    `window` (the beta.12 template has no email form; the test signs up through it).
 *    Dependencies are the published 1.0.0-beta.12 packages from npm.
 * 2. The app runs with KORA_AUTH_SECRET in Chromium: a user signs up, the page
 *    reloads (the store is now pinned to the signed-in device id), a todo typed into
 *    the form syncs to the server.
 * 3. The server stops (the device is offline). A second todo is typed into the form:
 *    a queued write.
 * 4. The app is upgraded to this branch's packages (packed tarballs, every @korajs
 *    package overridden), rebuilt with its own build script, and its unchanged
 *    `server.ts` restarted on the same database and secret. No bind script runs.
 * 5. The page is opened again. Without any user action the app reconnects (the
 *    server hands the ownerless node over) and the queued todo must reach the server.
 * 6. A second user may not take that node: signing up with the first user's device id
 *    is refused (DEVICE_OWNERSHIP_CONFLICT), and a second user's own token presenting
 *    the node id at the sync handshake is refused (NODE_ID_CLAIMED).
 *
 * Usage (after `pnpm build` here and in the beta.12 tree; needs npm registry access):
 *   PW_CHROMIUM_PATH=/opt/pw-browsers/chromium [KORA_PG_TEST_URL=postgres://...] \
 *     node scripts/remediation/compat-beta12-template-browser.mjs <beta12-build>
 * Optional: COMPAT_DATABASES=sqlite,postgres, COMPAT_KEEP=1 (keep the work directory),
 * COMPAT_VERBOSE=1. Prints one JSON line per database; exit 1 on any failure.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(fileURLToPath(import.meta.url), '../../..')
const b12 = process.argv[2] ? resolve(process.argv[2]) : null
if (!b12) {
	console.error('usage: compat-beta12-template-browser.mjs <path-to-beta12-build>')
	process.exit(2)
}
const { chromium } = createRequire(join(here, 'e2e/package.json'))('@playwright/test')
const requireServer = createRequire(join(here, 'packages/server/package.json'))
const WebSocket = requireServer('ws')
const verbose = Boolean(process.env.COMPAT_VERBOSE)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SECRET = 'compat-template-auth-secret-0123456789abcdef0123456789'

function run(cmd, args, cwd, env = {}) {
	const result = spawnSync(cmd, args, {
		cwd,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	})
	if (result.status !== 0) {
		throw new Error(
			`${cmd} ${args.join(' ')} failed in ${cwd}:\n${(result.stdout ?? '').slice(-3000)}\n${(result.stderr ?? '').slice(-3000)}`,
		)
	}
	return result.stdout
}

async function freePort() {
	return new Promise((done) => {
		const probe = createServer()
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address()
			probe.close(() => done(port))
		})
	})
}

async function waitFor(check, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs
	let last = null
	while (Date.now() < deadline) {
		try {
			if (await check()) return true
		} catch (error) {
			last = error
		}
		await sleep(250)
	}
	if (label) console.error(`[timeout] ${label}${last ? `: ${last}` : ''}`)
	return false
}

/** Pack every publishable package of this branch once; returns name -> tarball path. */
let packed = null
function packBranch(dir) {
	if (packed) return packed
	mkdirSync(dir, { recursive: true })
	const roots = [
		join(here, 'kora'),
		...readdirSync(join(here, 'packages')).map((p) => join(here, 'packages', p)),
	]
	packed = {}
	for (const root of roots) {
		let manifest
		try {
			manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
		} catch {
			continue
		}
		if (manifest.private) continue
		const before = new Set(readdirSync(dir))
		run('pnpm', ['pack', '--pack-destination', dir], root)
		const created = readdirSync(dir).find((f) => !before.has(f))
		if (created) packed[manifest.name] = join(dir, created)
	}
	return packed
}

/** The two app-side edits: a persistent user store, and the auth client on window. */
function patchApp(app) {
	const serverFile = join(app, 'server.ts')
	let server = readFileSync(serverFile, 'utf8')
	server = server.replace(
		'\tcreateKoraAuthServer,\n',
		'\tcreateKoraAuthServer,\n\tcreatePostgresUserStore,\n\tcreateSqliteUserStore,\n',
	)
	const before = server
	server = server.replace(
		'\treturn createKoraAuthServer({\n\t\tjwtSecret: process.env.KORA_AUTH_SECRET,\n',
		'\tconst userStore = process.env.DATABASE_URL\n' +
			'\t\t? await createPostgresUserStore({ connectionString: process.env.DATABASE_URL })\n' +
			"\t\t: await createSqliteUserStore({ filename: process.env.KORA_AUTH_DB || './kora-auth.db' })\n" +
			'\treturn createKoraAuthServer({\n\t\tjwtSecret: process.env.KORA_AUTH_SECRET,\n\t\tuserStore,\n',
	)
	if (server === before || !server.includes('createSqliteUserStore,')) {
		throw new Error('server.ts did not match the expected beta.12 template; update patchApp')
	}
	writeFileSync(serverFile, server)
	// beta.12 scaffolds keep their build allow-list only in package.json, which pnpm 11+
	// ignores (the install then fails on the ignored better-sqlite3/esbuild builds). Later
	// CLIs also write it to pnpm-workspace.yaml; do what a beta.12 user on such a pnpm does.
	if (!existsSync(join(app, 'pnpm-workspace.yaml'))) {
		const builds = ['better-sqlite3', 'esbuild', 'protobufjs']
		writeFileSync(
			join(app, 'pnpm-workspace.yaml'),
			`onlyBuiltDependencies:\n${builds.map((b) => `  - '${b}'`).join('\n')}\nallowBuilds:\n${builds.map((b) => `  '${b}': true`).join('\n')}\n`,
		)
	}
	// The beta.12 template's own `tsc` fails on src/auth.ts (VITE_AUTH_URL is not typed);
	// beta.13's template declares it. Same one-line fix here.
	const envTypes = join(app, 'src/vite-env.d.ts')
	const typed = readFileSync(envTypes, 'utf8')
	if (!typed.includes('VITE_AUTH_URL')) {
		writeFileSync(
			envTypes,
			typed.replace(
				'\treadonly VITE_SYNC_URL?: string\n',
				'\treadonly VITE_SYNC_URL?: string\n\treadonly VITE_AUTH_URL?: string\n',
			),
		)
	}
	const authFile = join(app, 'src/auth.ts')
	writeFileSync(
		authFile,
		`${readFileSync(authFile, 'utf8')}\n// compat test hook: the beta.12 template has no email form.\n;(window as unknown as { __koraAuth?: unknown }).__koraAuth = authClient\n`,
	)
}

/** Point the app at this branch: every @korajs package from the packed tarballs. */
function upgradeApp(app, tarballs) {
	const file = join(app, 'package.json')
	const manifest = JSON.parse(readFileSync(file, 'utf8'))
	for (const section of ['dependencies', 'devDependencies']) {
		for (const name of Object.keys(manifest[section] ?? {})) {
			if (tarballs[name]) manifest[section][name] = `file:${tarballs[name]}`
		}
	}
	manifest.pnpm = manifest.pnpm ?? {}
	manifest.pnpm.overrides = Object.fromEntries(
		Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`]),
	)
	writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

function startServer(app, env) {
	const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
		cwd: app,
		env: { ...process.env, NODE_ENV: 'development', ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let output = ''
	child.stdout.on('data', (d) => {
		output += d
		if (verbose) process.stderr.write(`[server] ${d}`)
	})
	child.stderr.on('data', (d) => {
		output += d
		if (verbose) process.stderr.write(`[server!] ${d}`)
	})
	return {
		child,
		output: () => output,
		ready: () => waitFor(() => output.includes('Kora app running at'), 60_000, 'server start'),
		async stop() {
			if (child.exitCode !== null) return
			child.kill('SIGTERM')
			await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000)
			if (child.exitCode === null) child.kill('SIGKILL')
		},
	}
}

async function serverTitles(db) {
	if (db.kind === 'sqlite') {
		const Database = requireServer('better-sqlite3')
		const conn = new Database(db.serverFile, { readonly: true, fileMustExist: true })
		try {
			return conn
				.prepare('SELECT title FROM todos')
				.all()
				.map((r) => r.title)
				.sort()
		} finally {
			conn.close()
		}
	}
	const pg = requireServer('postgres')(db.url, { max: 1, onnotice: () => {} })
	try {
		return (await pg.unsafe('SELECT title FROM todos')).map((r) => r.title).sort()
	} finally {
		await pg.end()
	}
}

async function openApp(ctx, url) {
	const page = await ctx.newPage()
	page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)))
	if (verbose) page.on('console', (m) => console.error('[page]', m.text().slice(0, 300)))
	await page.goto(url)
	await page.waitForSelector('input[placeholder="What needs to be done?"]', { timeout: 60_000 })
	return page
}

async function typeTodo(page, title) {
	const input = page.locator('input[placeholder="What needs to be done?"]')
	await input.fill('')
	await input.pressSequentially(title, { delay: 5 })
	await input.press('Enter')
	await page.getByText(title, { exact: true }).waitFor({ timeout: 20_000 })
}

/** Sign up through the app's own auth client; returns the device id its token carries. */
async function signUp(page, email) {
	return page.evaluate(async (e) => {
		const client = window.__koraAuth
		await client.signUp({ email: e, password: 'compat-password-1', name: 'Compat User' })
		const token = await client.getAccessToken()
		const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
		return payload.dev
	}, email)
}

async function postJson(url, body) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	return { status: response.status, body: await response.json().catch(() => null) }
}

/** A raw sync handshake presenting `nodeId` with `token`; resolves with the error code or 'accepted'. */
function handshake(wsUrl, nodeId, token) {
	return new Promise((done) => {
		const socket = new WebSocket(wsUrl)
		const timer = setTimeout(() => {
			socket.terminate()
			done('timeout')
		}, 15_000)
		socket.on('open', () => {
			socket.send(
				JSON.stringify({
					type: 'handshake',
					messageId: `compat-${Date.now()}`,
					nodeId,
					versionVector: {},
					schemaVersion: 1,
					authToken: token,
					protocolVersion: 2,
				}),
			)
		})
		socket.on('message', (raw) => {
			const message = JSON.parse(String(raw))
			if (message.type === 'error') {
				clearTimeout(timer)
				socket.close()
				done(message.code ?? 'error')
			} else if (message.type === 'handshake-response') {
				if (message.accepted === false) {
					clearTimeout(timer)
					socket.close()
					done(message.rejectReason ?? message.code ?? 'rejected')
				} else {
					// An accepted handshake may still be followed by the claim refusal.
					setTimeout(() => {
						clearTimeout(timer)
						socket.close()
						done('accepted')
					}, 1_500)
				}
			}
		})
		socket.on('error', () => {
			clearTimeout(timer)
			done('socket-error')
		})
	})
}

async function scenario(browser, work, kind) {
	const name = `browser/template/${kind}/beta12-to-current`
	const app = join(work, `app-${kind}`)
	const result = { scenario: name, ok: false }
	let server = null
	const ctx = await browser.newContext()
	try {
		// 1. Scaffold with beta.12's CLI; install beta.12 from npm; build.
		run(
			process.execPath,
			[
				join(b12, 'packages/cli/dist/bin.js'),
				'create',
				`app-${kind}`,
				'--platform',
				'web',
				'--template',
				'react-tailwind-sync',
				'--framework',
				'react',
				'--tailwind',
				'--sync',
				'--pm',
				'pnpm',
				'--db',
				kind === 'postgres' ? 'postgres' : 'sqlite',
				...(kind === 'postgres' ? ['--db-provider', 'local'] : []),
				'--auth',
				'none',
				'--skip-install',
			],
			work,
		)
		patchApp(app)
		const installed = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).dependencies
			.korajs
		result.scaffoldedVersion = installed
		run('pnpm', ['install', '--no-frozen-lockfile'], app)
		run('pnpm', ['build'], app)

		let db
		if (kind === 'sqlite') {
			db = {
				kind,
				serverFile: join(app, 'kora-server.db'),
				env: {
					KORA_SERVER_DB: join(app, 'kora-server.db'),
					KORA_AUTH_DB: join(app, 'kora-auth.db'),
				},
			}
		} else {
			const pg = requireServer('postgres')(process.env.KORA_PG_TEST_URL, {
				max: 1,
				onnotice: () => {},
			})
			const dbName = `kora_compat_tmpl_${process.pid}`
			await pg.unsafe(`DROP DATABASE IF EXISTS ${dbName}`)
			await pg.unsafe(`CREATE DATABASE ${dbName}`)
			await pg.end()
			const url = new URL(process.env.KORA_PG_TEST_URL)
			url.pathname = `/${dbName}`
			db = { kind, url: url.toString(), env: { DATABASE_URL: url.toString() } }
		}
		const port = await freePort()
		const env = { ...db.env, PORT: String(port), KORA_AUTH_SECRET: SECRET }
		const origin = `http://127.0.0.1:${port}`

		// 2. beta.12: sign up, reload, type a todo that syncs.
		server = startServer(app, env)
		if (!(await server.ready()))
			throw new Error(`beta.12 server did not start:\n${server.output()}`)
		let page = await openApp(ctx, origin)
		const email = `compat-${kind}-${Date.now()}@example.com`
		const deviceId = await signUp(page, email)
		result.deviceId = deviceId
		await page.close()
		page = await openApp(ctx, origin)
		await typeTodo(page, 'synced on beta.12')
		result.syncedOnBeta12 = await waitFor(
			async () => (await serverTitles(db)).includes('synced on beta.12'),
			60_000,
			'beta.12 sync',
		)

		// 3. Offline: the server is gone; a todo typed now is queued on the device.
		await server.stop()
		server = null
		await sleep(500)
		await typeTodo(page, 'typed offline on beta.12')
		await sleep(1_000)
		await page.close()

		// 4. Upgrade the app to this branch and restart its unchanged server.ts.
		upgradeApp(app, packBranch(join(work, 'tarballs')))
		run('pnpm', ['install', '--no-frozen-lockfile'], app)
		result.upgradedVersion = JSON.parse(
			readFileSync(join(app, 'node_modules/korajs/package.json'), 'utf8'),
		).version
		run('pnpm', ['build'], app)
		server = startServer(app, env)
		if (!(await server.ready()))
			throw new Error(`upgraded server did not start:\n${server.output()}`)

		// 5. Reopen: the app reconnects by itself and the queued todo uploads.
		page = await openApp(ctx, origin)
		result.offlineWriteUploaded = await waitFor(
			async () => (await serverTitles(db)).includes('typed offline on beta.12'),
			90_000,
			'queued write upload',
		)
		result.serverTitles = await serverTitles(db)
		result.handoverLogged = server.output().includes('node_claim.handover')
		await page.close()

		// 6. Another user may not take the node.
		const stolenDevice = await postJson(`${origin}/auth/signup`, {
			email: `intruder-${kind}-${Date.now()}@example.com`,
			password: 'compat-password-2',
			name: 'Intruder',
			deviceId,
		})
		result.secondUserSameDevice = stolenDevice.body?.code ?? stolenDevice.status
		const intruder = await postJson(`${origin}/auth/signup`, {
			email: `intruder2-${kind}-${Date.now()}@example.com`,
			password: 'compat-password-2',
			name: 'Intruder',
		})
		const intruderToken = intruder.body?.data?.tokens?.accessToken
		result.secondUserHandshake = intruderToken
			? await handshake(`ws://127.0.0.1:${port}/kora-sync`, deviceId, intruderToken)
			: `no token (${intruder.status})`

		result.ok =
			result.syncedOnBeta12 === true &&
			result.offlineWriteUploaded === true &&
			result.secondUserSameDevice === 'DEVICE_OWNERSHIP_CONFLICT' &&
			result.secondUserHandshake === 'NODE_ID_CLAIMED'
	} catch (error) {
		result.error = String(error?.stack ?? error).slice(0, 4000)
	} finally {
		if (verbose && server) result.serverOutput = server.output().slice(-4000)
		await server?.stop().catch(() => {})
		await ctx.close()
	}
	console.log(JSON.stringify(result))
	return result.ok
}

const kinds = (process.env.COMPAT_DATABASES ?? 'sqlite,postgres')
	.split(',')
	.filter((kind) => kind === 'sqlite' || (kind === 'postgres' && process.env.KORA_PG_TEST_URL))
const work = mkdtempSync(join(tmpdir(), 'kora-compat-tmpl-'))
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined })
const results = []
for (const kind of kinds) results.push(await scenario(browser, work, kind))
await browser.close()
if (process.env.COMPAT_KEEP) console.error(`work directory kept: ${work}`)
else rmSync(work, { recursive: true, force: true })
process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1)
