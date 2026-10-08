#!/usr/bin/env node
/**
 * Real-browser upgrade of an `@korajs/auth` app from 1.0.0-beta.12 to this release, with
 * NO node-binding script (F1, automatic device handover).
 *
 * For each database (SQLite files, and Postgres when KORA_PG_TEST_URL is set):
 *
 * 1. A beta.12 production server (sync + `/auth`, persistent user store, the template's
 *    wiring) serves a beta.12 page in Chromium: `createApp` with
 *    `createKoraAuthSync({ authClient })`. A user signs up, writes a todo that syncs,
 *    goes offline, edits it and adds another (queued offline writes), and closes.
 * 2. The server process is replaced by this release on the same files / database, same
 *    port and JWT secret. Nothing else runs.
 * 3. The upgraded page (this release's build, same origin and storage) restores the
 *    session and connects, and both offline writes must reach the server:
 *    - flow `reloaded` (the page reloaded after sign-up, so beta.12 authored under the
 *      device id): the server hands the ownerless node over (`node_claim.handover`) and
 *      the writes upload with no app code;
 *    - flow `same-page` (signed up and wrote without a reload, so beta.12 authored under
 *      the random node it opened with): the writes are reported held `unassigned`, do
 *      not upload until the app calls `app.sync.assignHeld`, then upload (re-authored
 *      under a fresh node of the user's, the part beta.12 uploaded not repeated).
 *
 * A control run with `deviceNodeHandover: false` checks the `reloaded` scenario is
 * meaningful: the device is refused NODE_ID_CLAIMED and the offline edit does not upload.
 *
 * Usage (after `pnpm build` here and in the beta.12 tree):
 *   PW_CHROMIUM_PATH=/opt/pw-browsers/chromium [KORA_PG_TEST_URL=postgres://...] \
 *     node scripts/remediation/compat-beta12-auth-browser.mjs <beta12-build>
 * Optional: COMPAT_DATABASES=sqlite,postgres, COMPAT_FLOWS=reloaded,same-page,
 * COMPAT_SKIP_CONTROL=1, COMPAT_VERBOSE=1. Prints one JSON line per scenario; exit 1 on
 * any failure.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = resolve(fileURLToPath(import.meta.url), '../../..')
const b12 = process.argv[2] ? resolve(process.argv[2]) : null
if (!b12) {
	console.error('usage: compat-beta12-auth-browser.mjs <path-to-beta12-build>')
	process.exit(2)
}
const requireHere = createRequire(join(here, 'package.json'))
const esbuild = createRequire(requireHere.resolve('tsup'))('esbuild')
const { chromium } = createRequire(join(here, 'e2e/package.json'))('@playwright/test')
const load = (root, path) => import(pathToFileURL(join(root, path)).href)

const trees = {
	b12: {
		root: b12,
		kora: await load(b12, 'kora/dist/index.js'),
		server: await load(b12, 'packages/server/dist/index.js'),
		authServer: await load(b12, 'packages/auth/dist/server.js'),
	},
	cur: {
		root: here,
		kora: await load(here, 'kora/dist/index.js'),
		server: await load(here, 'packages/server/dist/index.js'),
		authServer: await load(here, 'packages/auth/dist/server.js'),
	},
}

const SECRET = 'compat-beta12-auth-secret-0123456789abcdef0123456789'
const out = mkdtempSync(join(tmpdir(), 'kora-compat-b12-auth-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The page: the template's client wiring, from whichever build the bundle imports. */
const pageSource = (root, tag) => `
import { createApp, defineSchema, t } from ${JSON.stringify(join(root, 'kora/dist/index.js'))}
import { createKoraAuth, createKoraAuthSync } from ${JSON.stringify(join(root, 'packages/auth/dist/index.js'))}

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), completed: t.boolean().default(false) } } },
})
let app = null
let authClient = null
const events = []
window.K = {
	tag: ${JSON.stringify(tag)},
	events,
	async open() {
		authClient = createKoraAuth({ serverUrl: location.origin })
		app = createApp({
			schema,
			sync: {
				url: (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/kora-sync',
				authClient: createKoraAuthSync({ authClient, schema }),
			},
			store: { workerUrl: '/${tag}-worker.js' },
		})
		for (const type of ['sync:connected', 'sync:disconnected', 'sync:operation-rejected', 'store:persistence-error', 'sync:suspended']) {
			try { app.events.on(type, (e) => events.push({ type, reason: e?.reason ?? null, code: e?.code ?? null })) } catch {}
		}
		// As the template does: the app is created at module load, and the auth
		// provider initializes the client (restoring a stored session) on mount.
		await authClient.initialize()
		await app.ready
		return true
	},
	async signUp(email, password) {
		await authClient.signUp({ email, password, name: 'Compat User' })
		return authClient.isAuthenticated
	},
	isAuthenticated() { return authClient.isAuthenticated },
	async connect() { await app.sync.connect() },
	async disconnect() { await app.sync.disconnect() },
	async insert(title) { return (await app.todos.insert({ title })).id },
	async update(id, title) { await app.todos.update(id, { title }) },
	async titles() { return (await app.todos.where({}).exec()).map((r) => r.title).sort() },
	status() { const s = app.sync?.getStatus?.(); return s ? { status: s.status, pending: s.pendingOperations, reason: s.reason ?? null, held: s.heldOperations ?? null } : null },
	async heldNodes() { return JSON.parse(JSON.stringify(app.sync?.getStatus?.().heldNodes ?? [])) },
	async assignHeld(nodeId) { await app.sync.assignHeld(nodeId, 'current-user') },
	fullStatus() { return JSON.parse(JSON.stringify(app.sync?.getStatus?.() ?? null)) },
	async close() { await app.close(); app = null; return true },
}
window.__ready = true
`

async function buildPages() {
	const common = {
		bundle: true,
		format: 'esm',
		target: 'es2022',
		logLevel: 'error',
		platform: 'browser',
	}
	for (const tag of ['b12', 'cur']) {
		const root = trees[tag].root
		const entry = join(out, `${tag}-page-entry.js`)
		writeFileSync(entry, pageSource(root, tag))
		await esbuild.build({ ...common, entryPoints: [entry], outfile: join(out, `${tag}-page.js`) })
		const workerEntry = join(out, `${tag}-worker-entry.js`)
		writeFileSync(
			workerEntry,
			`globalThis.__KORA_SQLITE_WASM_URL = '/${tag}-sqlite3.wasm'\nawait import(${JSON.stringify(
				join(root, 'packages/store/dist/adapters/sqlite-wasm-worker.js'),
			)})\n`,
		)
		await esbuild.build({
			...common,
			entryPoints: [workerEntry],
			outfile: join(out, `${tag}-worker.js`),
		})
		const wasm = join(
			root,
			'packages/store/node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm',
		)
		writeFileSync(join(out, `${tag}-sqlite3.wasm`), await readFile(wasm))
		if (tag === 'b12') writeFileSync(join(out, 'sqlite3.wasm'), await readFile(wasm))
		writeFileSync(
			join(out, `${tag}.html`),
			`<!doctype html><meta charset=utf-8><title>${tag}</title><script type=module src=/${tag}-page.js></script>`,
		)
	}
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

function schemaOf(tree) {
	const { defineSchema, t } = tree.kora
	return defineSchema({
		version: 1,
		collections: {
			todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
		},
	})
}

/** The template's production server (sync + /auth) of one release, on `db`. */
async function startServer(tag, db, port, syncExtra = {}) {
	const tree = trees[tag]
	const store =
		db.kind === 'sqlite'
			? tree.server.createSqliteServerStore({ filename: db.serverFile })
			: await tree.server.createPostgresServerStore({ connectionString: db.url })
	await store.setSchema(schemaOf(tree))
	const userStore =
		db.kind === 'sqlite'
			? await tree.authServer.createSqliteUserStore({ filename: db.authFile })
			: await tree.authServer.createPostgresUserStore({ connectionString: db.url })
	const auth = tree.authServer.createKoraAuthServer({ jwtSecret: SECRET, userStore })
	const events = []
	const logger = { log: (entry) => events.push(entry) }
	const server = tree.server.createProductionServer({
		store,
		port,
		staticDir: out,
		httpRoutes: [{ path: '/auth', handle: (request) => auth.handleRequest(request) }],
		syncOptions: { auth: auth.auth, logger, ...syncExtra },
	})
	const url = await server.start()
	return {
		url,
		events,
		store,
		async findTitles() {
			return (await store.queryCollection('todos', {})).map((row) => row.title).sort()
		},
		async stop() {
			await server.stop()
			await store.close?.()
			await userStore.close?.()
		},
	}
}

async function waitFor(check, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await check()) return true
		await sleep(250)
	}
	return false
}

async function openPage(ctx, origin, tag) {
	const page = await ctx.newPage()
	page.on('pageerror', (e) => console.error(`[${tag} pageerror]`, String(e).slice(0, 300)))
	if (process.env.COMPAT_VERBOSE)
		page.on('console', (m) => console.error(`[${tag}]`, m.text().slice(0, 300)))
	await page.goto(`${origin}/${tag}.html`)
	await page.waitForFunction(() => window.__ready === true)
	await page.evaluate(() => window.K.open())
	return page
}

/**
 * `flow`:
 * - 'reloaded': the user signed up, the page reloaded (the store is pinned to the device
 *   id), then wrote. After the upgrade the device takes its node over (handover) and
 *   the offline writes upload with no app code.
 * - 'same-page': the user signed up and wrote without a reload, so beta.12 authored
 *   under the random node the app opened with before anyone signed in. Those writes
 *   cannot be attributed (beta.12 recorded no owner): they must be reported held
 *   (`unassigned`), and upload once the app assigns them (`app.sync.assignHeld`).
 * `handover: false` is the control: the beta.13 refusal comes back.
 */
async function scenario(browser, db, { flow, handover }) {
	const name = `browser/auth/${db.kind}/beta12-to-current/${flow}${handover ? '' : '/control-handover-off'}`
	const port = await freePort()
	const ctx = await browser.newContext()
	let server = null
	try {
		// 1. beta.12: sign up, sync a todo, then queue offline writes.
		server = await startServer('b12', db, port)
		const origin = server.url
		let legacy = await openPage(ctx, origin, 'b12')
		const email = `compat-${Date.now()}@example.com`
		await legacy.evaluate(([e, p]) => window.K.signUp(e, p), [email, 'compat-password-1'])
		if (flow === 'reloaded') {
			await legacy.evaluate(() => window.K.close())
			await legacy.close()
			legacy = await openPage(ctx, origin, 'b12')
		}
		await legacy.evaluate(() => window.K.connect())
		const id = await legacy.evaluate(() => window.K.insert('synced on beta.12'))
		const synced = await waitFor(
			async () => (await server.findTitles()).includes('synced on beta.12'),
			60_000,
		)
		await legacy.evaluate(() => window.K.disconnect())
		await legacy.evaluate((recordId) => window.K.update(recordId, 'edited offline on beta.12'), id)
		await legacy.evaluate(() => window.K.insert('added offline on beta.12'))
		const legacyPending = await legacy.evaluate(() => window.K.status())
		await legacy.evaluate(() => window.K.close())
		await legacy.close()
		await server.stop()
		server = null

		// 2. This release on the same database, port and secret. No bind script.
		server = await startServer('cur', db, port, handover ? {} : { deviceNodeHandover: false })
		// 3. The upgraded page restores the session and connects.
		const upgraded = await openPage(ctx, origin, 'cur')
		const signedIn = await upgraded.evaluate(() => window.K.isAuthenticated())
		await upgraded.evaluate(() => window.K.connect()).catch(() => {})
		const wanted = ['added offline on beta.12', 'edited offline on beta.12']
		const allUploaded = async () => {
			const titles = await server.findTitles()
			return wanted.every((title) => titles.includes(title))
		}
		let held = null
		let assigned = null
		if (flow === 'same-page') {
			// Reported, not stranded: held as unassigned once the session started.
			await waitFor(
				async () => (await upgraded.evaluate(() => window.K.heldNodes())).length > 0,
				20_000,
			)
			held = await upgraded.evaluate(() => window.K.heldNodes())
			const uploadedBeforeAssign = await allUploaded()
			if (uploadedBeforeAssign)
				throw new Error('unattributable writes uploaded before the app assigned them')
			assigned = []
			for (const node of held) {
				if (node.reason !== 'unassigned') continue
				await upgraded.evaluate((nodeId) => window.K.assignHeld(nodeId), node.nodeId)
				assigned.push(node.nodeId)
			}
		}
		const uploaded = await waitFor(allUploaded, handover ? 60_000 : 10_000)
		const serverTitles = await server.findTitles()
		const handoverLogged = server.events.some((e) => e.event === 'node_claim.handover')
		const refused = server.events.some((e) => JSON.stringify(e).includes('NODE_ID_CLAIMED'))
		const status = await upgraded.evaluate(() => window.K.status())
		if (process.env.COMPAT_VERBOSE) {
			console.error(
				'full status',
				JSON.stringify(await upgraded.evaluate(() => window.K.fullStatus())),
				'titles',
				JSON.stringify(await upgraded.evaluate(() => window.K.titles())),
			)
		}
		const pageEvents = await upgraded.evaluate(() => window.K.events)
		let ok
		if (flow === 'reloaded') {
			ok = handover
				? synced && signedIn && uploaded && handoverLogged && !refused
				: synced && signedIn && !uploaded && !handoverLogged
		} else {
			ok =
				synced &&
				signedIn &&
				held !== null &&
				held.length > 0 &&
				held.every((node) => node.reason === 'unassigned') &&
				uploaded
		}
		console.log(
			JSON.stringify({
				scenario: name,
				ok,
				syncedOnBeta12: synced,
				queuedOnBeta12: legacyPending,
				sessionRestored: signedIn,
				held,
				assigned,
				offlineWritesUploaded: uploaded,
				handoverLogged,
				refusedLogged: refused,
				serverTitles,
				status,
				pageEvents: pageEvents.slice(-6),
				...(process.env.COMPAT_VERBOSE ? { serverEvents: server.events.slice(-30) } : {}),
			}),
		)
		await upgraded.evaluate(() => window.K.close())
		return ok
	} catch (error) {
		console.log(
			JSON.stringify({
				scenario: name,
				ok: false,
				error: String(error?.stack ?? error).slice(0, 1500),
			}),
		)
		return false
	} finally {
		await server?.stop().catch(() => {})
		await ctx.close()
	}
}

/**
 * Each scenario runs in its own process: V8 caches a `new Function('specifier', 'return
 * import(specifier)')` body together with the module that compiled it first, so in one
 * process beta.12's Postgres server store would resolve `drizzle-orm` from the auth
 * package (which lacks it) on its second start. A harness artifact, not a product one.
 */
async function runOne(spec) {
	await buildPages()
	const browser = await chromium.launch({
		executablePath: process.env.PW_CHROMIUM_PATH || undefined,
	})
	let db
	if (spec.kind === 'sqlite') {
		const dir = mkdtempSync(join(tmpdir(), 'kora-compat-b12-auth-db-'))
		db = {
			kind: 'sqlite',
			serverFile: join(dir, 'kora-server.db'),
			authFile: join(dir, 'kora-auth.db'),
			dir,
		}
	} else {
		const pgModule = createRequire(join(here, 'packages/server/package.json'))('postgres')
		const dbName = `kora_compat_auth_${process.pid}_${Math.floor(Math.random() * 1e6)}`
		const admin = pgModule(process.env.KORA_PG_TEST_URL, { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE DATABASE ${dbName}`)
		await admin.end()
		const url = new URL(process.env.KORA_PG_TEST_URL)
		url.pathname = `/${dbName}`
		db = { kind: 'postgres', url: url.toString() }
	}
	const ok = await scenario(browser, db, { flow: spec.flow, handover: spec.handover })
	await browser.close()
	rmSync(out, { recursive: true, force: true })
	if (db.dir) rmSync(db.dir, { recursive: true, force: true })
	return ok
}

if (process.env.COMPAT_ONE) {
	process.exit((await runOne(JSON.parse(process.env.COMPAT_ONE))) ? 0 : 1)
}

const kinds = (process.env.COMPAT_DATABASES ?? 'sqlite,postgres')
	.split(',')
	.filter((kind) => kind === 'sqlite' || (kind === 'postgres' && process.env.KORA_PG_TEST_URL))
const flows = (process.env.COMPAT_FLOWS ?? 'reloaded,same-page').split(',')
const specs = []
for (const kind of kinds) {
	for (const flow of flows) specs.push({ kind, flow, handover: true })
	if (!process.env.COMPAT_SKIP_CONTROL) specs.push({ kind, flow: 'reloaded', handover: false })
}
const { spawnSync } = await import('node:child_process')
const results = specs.map((spec) => {
	const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), b12], {
		env: { ...process.env, COMPAT_ONE: JSON.stringify(spec) },
		stdio: ['ignore', 'inherit', 'inherit'],
	})
	return child.status === 0
})
rmSync(out, { recursive: true, force: true })
process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1)
