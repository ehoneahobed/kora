#!/usr/bin/env node
/**
 * Compatibility matrix against the last PUBLISHED release, 1.0.0-beta.12
 * (tag v1.0.0-beta.12, commit 91c6350), over real WebSockets.
 *
 * beta.12 (and older) speak sync protocol 1; this release (1.0.0-beta.13) speaks
 * protocol 2 and serves protocol-1 clients for one release. Commit 33bca46 (the
 * Phase 1 merge) was never released: it is not a legacy client in the field.
 *
 * Usage:
 *   git worktree add --detach /tmp/b12 v1.0.0-beta.12   (or: git archive v1.0.0-beta.12 | tar -x -C /tmp/b12)
 *   (cd /tmp/b12 && pnpm install --frozen-lockfile && pnpm build)
 *   node scripts/remediation/compat-beta12.mjs /tmp/b12 [filter ...]
 *
 * Environment:
 *   KORA_PG_TEST_URL  a Postgres database (owner rights) for the Postgres server-store rows
 *   COMPAT_SEEDS      chaos seeds (default "1,2,3")
 *
 * Every scenario prints one JSON line `{ scenario, ok, ... }`; exit 1 when any is not ok.
 * Scenarios (filter matches a substring of the name):
 *   shapes/b12-client/current-server/{memory,sqlite,postgres}
 *   shapes/current-client/b12-server/{memory,sqlite}
 *   upgrade/client-db/{offline,synced-b12-server,synced-current-server}
 *   upgrade/server-db/{sqlite,postgres}/{none,token,anonymous}
 *   chaos/{current-server,b12-server}/seed-N
 *   encryption/b12-client/current-server/{optional,required,migration}
 *   encryption/current-clients/b12-server
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(fileURLToPath(import.meta.url), '../../..')
const b12 = process.argv[2]
if (!b12) {
	console.error('usage: compat-beta12.mjs <path-to-beta12-build> [filter ...]')
	process.exit(2)
}
const filters = process.argv.slice(3)
const PG_URL = process.env.KORA_PG_TEST_URL
const SEEDS = (process.env.COMPAT_SEEDS ?? '1,2,3').split(',').map(Number)

async function load(root) {
	return {
		kora: await import(join(root, 'kora/dist/index.js')),
		server: await import(join(root, 'packages/server/dist/index.js')),
		sync: await import(join(root, 'packages/sync/dist/index.js')),
		core: await import(join(root, 'packages/core/dist/index.js')),
	}
}
const cur = await load(here)
const old = await load(resolve(b12))
const Y = createRequire(join(here, 'packages/store/package.json'))('yjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- deterministic random

function rng(seed) {
	let s = seed >>> 0 || 1
	return () => {
		s ^= s << 13
		s ^= s >>> 17
		s ^= s << 5
		return ((s >>> 0) % 1_000_000) / 1_000_000
	}
}

// ---------------------------------------------------------------- chaos on the real transport

/**
 * Route every WebSocketTransport of one build through that build's own ChaosTransport
 * (drop, duplicate, reorder, latency), so mixed fleets run the real client stacks under
 * the same faults the chaos suites use. `state.calm` switches the faults off (heal).
 */
function installChaos(syncPkg, state) {
	const proto = syncPkg.WebSocketTransport.prototype
	if (proto.__chaosInstalled) return
	proto.__chaosInstalled = true
	const orig = {}
	for (const m of [
		'connect',
		'disconnect',
		'send',
		'onMessage',
		'onClose',
		'onError',
		'isConnected',
	]) {
		orig[m] = proto[m]
	}
	const chaosOf = (self) => {
		if (!self.__chaos) {
			const inner = {}
			for (const m of Object.keys(orig)) inner[m] = (...args) => orig[m].apply(self, args)
			const random = state.random
			self.__chaos = new syncPkg.ChaosTransport(inner, {
				dropRate: state.dropRate,
				duplicateRate: state.duplicateRate,
				reorderRate: state.reorderRate,
				maxLatency: state.maxLatency,
				// Calm: every draw is above every rate (no drop, duplicate or reorder) and
				// latency collapses to ~0.
				randomSource: () => (state.calm ? 0.999999 : random()),
			})
		}
		return self.__chaos
	}
	for (const m of Object.keys(orig)) {
		proto[m] = function (...args) {
			if (!state.enabled) return orig[m].apply(this, args)
			return chaosOf(this)[m](...args)
		}
	}
}
const chaosState = {
	enabled: false,
	calm: false,
	dropRate: 0.1,
	duplicateRate: 0.05,
	reorderRate: 0.05,
	maxLatency: 30,
	random: Math.random,
}
installChaos(cur.sync, chaosState)
installChaos(old.sync, chaosState)

// ---------------------------------------------------------------- shared fixtures

function schemaOf(kora, { onDelete = 'cascade' } = {}) {
	const { t } = kora
	return kora.defineSchema({
		version: 1,
		collections: {
			projects: { fields: { name: t.string() } },
			notes: {
				fields: {
					title: t.string(),
					assignee: t.string().optional(),
					meta: t.object({ a: t.number().optional(), b: t.string().optional() }).optional(),
					n: t.number().default(0),
					tags: t.array(t.string()).default([]),
					extra: t.json().optional(),
					due: t.timestamp().optional(),
					body: t.richtext(),
					projectId: t.string().optional(),
				},
			},
		},
		relations: {
			noteProject: {
				from: 'notes',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId',
				onDelete,
			},
		},
	})
}

function yText(text) {
	const doc = new Y.Doc()
	doc.getText('content').insert(0, text)
	return Y.encodeStateAsUpdate(doc)
}
function richToText(value) {
	if (value === null || value === undefined) return null
	if (typeof value === 'string') return value
	try {
		const doc = new Y.Doc()
		Y.applyUpdate(doc, value instanceof Uint8Array ? value : new Uint8Array(value))
		return doc.getText('content').toString()
	} catch {
		return `<unreadable ${String(value).slice(0, 20)}>`
	}
}

function canonical(value) {
	if (value instanceof Date) return JSON.stringify(value.getTime())
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.filter((k) => value[k] !== undefined && value[k] !== null)
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(',')}}`
	}
	return JSON.stringify(value ?? null)
}

/** The user-visible content of a row (store-set timestamps are per device). */
function content(collection, row) {
	if (!row) return null
	const { createdAt: _c, updatedAt: _u, ...rest } = row
	if (collection === 'notes') rest.body = richToText(rest.body)
	return canonical(rest)
}

async function snapshot(app) {
	const out = {}
	for (const collection of ['projects', 'notes']) {
		const rows = await app[collection].where({}).exec()
		for (const row of rows) out[`${collection}/${row.id}`] = content(collection, row)
	}
	return out
}

function diffSnapshots(a, b) {
	const diffs = []
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (a[key] !== b[key]) diffs.push({ key, a: a[key] ?? null, b: b[key] ?? null })
	}
	return diffs
}

async function freePort() {
	return new Promise((res, rej) => {
		const srv = createServer()
		srv.once('error', rej)
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address()
			srv.close(() => res(port))
		})
	})
}

async function until(fn, label, ms = 20000) {
	const end = Date.now() + ms
	let last
	while (Date.now() < end) {
		last = await fn()
		if (last === true) return
		await sleep(100)
	}
	throw new Error(
		`timeout: ${label}${last && last !== true ? ` (${JSON.stringify(last).slice(0, 400)})` : ''}`,
	)
}

const WATCHED_EVENTS = [
	'sync:operation-rejected',
	'sync:apply-failed',
	'sync:forged-duplicate',
	'sync:protocol-deprecated',
	'sync:unverified-legacy-operation',
	'sync:error',
]

function watch(app, name) {
	const seen = []
	for (const type of WATCHED_EVENTS) {
		try {
			app.events.on(type, (event) => {
				seen.push({
					app: name,
					type,
					code: event?.code ?? event?.rejection?.code ?? event?.error?.code,
				})
			})
		} catch {
			// unknown event type on this build
		}
	}
	return seen
}

async function makeServer(pkg, kora, { store, port, auth, logger, onDelete, ...rest }) {
	const s = store ?? new pkg.server.MemoryServerStore()
	await s.setSchema(schemaOf(kora, onDelete ? { onDelete } : {}))
	const server = pkg.server.createKoraServer({
		store: s,
		port,
		...(auth ? { auth } : {}),
		...(logger ? { logger } : {}),
		...rest,
	})
	await server.start()
	return { server, store: s, url: `ws://127.0.0.1:${port}` }
}

function makeApp(pkg, file, { url, token, encryption, onDelete } = {}) {
	return pkg.kora.createApp({
		schema: schemaOf(pkg.kora, onDelete ? { onDelete } : {}),
		store: { adapter: 'better-sqlite3', name: file },
		...(url
			? {
					sync: {
						url,
						...(token !== undefined ? { auth: async () => ({ token }) } : {}),
						...(encryption ? { encryption } : {}),
					},
				}
			: {}),
	})
}

const warnLog = (into) => ({
	log: (e) => {
		if (e.level === 'warn' || e.level === 'error') {
			into.push(e.event)
			if (process.env.COMPAT_VERBOSE)
				console.error('[server]', e.level, e.event, JSON.stringify(e.details ?? {}).slice(0, 400))
		}
	},
})

// A beta.12 SyncEngine throws "WebSocket is not connected" from an un-awaited flush when
// the server closes its socket; record such rejections instead of crashing the matrix.
const unhandled = []
process.on('unhandledRejection', (reason) => {
	unhandled.push(String(reason?.message ?? reason).slice(0, 200))
	if (process.env.COMPAT_VERBOSE) console.error('[unhandled]', reason)
})

const results = []
async function scenario(name, run) {
	if (filters.length > 0 && !filters.some((f) => name.includes(f))) return
	const dir = mkdtempSync(join(tmpdir(), 'kora-compat-b12-'))
	const started = Date.now()
	try {
		unhandled.length = 0
		const details = await run(dir)
		if (unhandled.length > 0) details.unhandledRejections = [...new Set(unhandled)]
		const ok = details?.ok !== false
		results.push(ok)
		console.log(JSON.stringify({ scenario: name, ok, ms: Date.now() - started, ...details }))
	} catch (error) {
		results.push(false)
		console.log(
			JSON.stringify({
				scenario: name,
				ok: false,
				error: String(error?.stack ?? error).slice(0, 2000),
			}),
		)
	} finally {
		chaosState.enabled = false
		chaosState.calm = false
		rmSync(dir, { recursive: true, force: true })
	}
}

// ---------------------------------------------------------------- the write workload

/**
 * Every write shape a beta.12 app produces, on one app (any build): plain and
 * nested-undefined inserts, top-level and nested `undefined` clears, increments,
 * arrays, json with a Date, timestamps (Date and ms), binary richtext, unicode,
 * transactions (beta.12: a transaction followed by a single write share a sequence
 * number, STORE-1), and a cascading delete.
 */
async function writeShapes(app, pkg, tag) {
	const op = pkg.core.op
	const ids = {}
	const p = await app.projects.insert({ name: `${tag}-project` })
	ids.project = p.id
	const a = await app.notes.insert({
		title: `${tag} é😀  `,
		assignee: 'bob',
		meta: { a: 1, b: undefined },
		n: 1,
		tags: ['b', 'a', 'a'],
		extra: { when: new Date(1700000000000), z: [1, { b: 2, a: 0.1 + 0.2 }], m: 5e-324 },
		due: 1700000000123,
		body: yText(`${tag} body`),
		projectId: p.id,
	})
	ids.a = a.id
	await app.notes.update(a.id, { assignee: undefined, title: `${tag}-cleared` })
	await app.notes.update(a.id, { n: op.increment(2) })
	await app.notes.update(a.id, { meta: { a: 2, b: undefined }, tags: ['x', 'y'] })
	await app.notes.update(a.id, { due: 1700000000999, extra: { q: null, s: 'ü' } })
	// beta.12 STORE-1: the apply pipeline's transaction commit never persisted the
	// sequence counter, so the next single write re-used the transaction's number.
	let txNote
	await app.transaction(async (tx) => {
		txNote = await tx.notes.insert({ title: `${tag}-tx`, n: 5, body: yText('tx'), projectId: p.id })
		await tx.notes.update(txNote.id, { n: 6, tags: ['t'] })
	})
	ids.tx = txNote.id
	const after = await app.notes.insert({ title: `${tag}-after-tx`, body: yText('after') })
	ids.afterTx = after.id
	// Two concurrent transactions (beta.12 and the Phase 1 build gave both one number).
	await Promise.all([
		app.transaction(async (tx) => {
			await tx.notes.insert({ title: `${tag}-ctx1`, body: yText('c1') })
		}),
		app.transaction(async (tx) => {
			await tx.notes.insert({ title: `${tag}-ctx2`, body: yText('c2') })
		}),
	])
	const doomed = await app.projects.insert({ name: `${tag}-doomed` })
	const child = await app.notes.insert({
		title: `${tag}-child`,
		body: yText('c'),
		projectId: doomed.id,
	})
	ids.child = child.id
	await app.projects.delete(doomed.id)
	const gone = await app.notes.insert({ title: `${tag}-deleted`, body: yText('d') })
	await app.notes.delete(gone.id)
	return ids
}

async function settleAll(apps, ms = 1500) {
	for (const app of apps) {
		try {
			await app.sync?.waitForSettled?.({ timeoutMs: ms })
		} catch {
			// best effort
		}
	}
}

/** Wait until every app holds the same rows; returns the snapshots. */
async function converge(apps, label, ms = 30000) {
	let snaps = []
	await until(
		async () => {
			snaps = await Promise.all(apps.map((a) => snapshot(a)))
			const diffs = snaps
				.slice(1)
				.flatMap((s, i) => diffSnapshots(snaps[0], s).map((d) => ({ replica: i + 1, ...d })))
			if (diffs.length === 0) return true
			return {
				counts: snaps.map((s) => Object.keys(s).length),
				phases: apps.map((a) => a.sync?.getStatus?.()?.phase ?? null),
				diffs: diffs.length,
				sample: diffs.slice(0, 2),
			}
		},
		label,
		ms,
	)
	return snaps
}

// ---------------------------------------------------------------- scenarios

async function serverStoreFor(pkg, kind, dir, name) {
	if (kind === 'memory') return new pkg.server.MemoryServerStore()
	if (kind === 'sqlite')
		return pkg.server.createSqliteServerStore({ filename: join(dir, `${name}.sqlite`) })
	if (kind === 'postgres') return pkg.server.createPostgresServerStore({ connectionString: PG_URL })
	throw new Error(kind)
}

async function resetPg() {
	const postgres = createRequire(join(here, 'packages/server/package.json'))('postgres')
	const sql = postgres(PG_URL, { onnotice: () => {} })
	await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
	await sql.end()
}

for (const kind of ['memory', 'sqlite', 'postgres']) {
	await scenario(`shapes/b12-client/current-server/${kind}`, async (dir) => {
		if (kind === 'postgres' && !PG_URL) return { skipped: 'KORA_PG_TEST_URL not set' }
		if (kind === 'postgres') await resetPg()
		const warnings = []
		const port = await freePort()
		const { server, store, url } = await makeServer(cur, cur.kora, {
			store: await serverStoreFor(cur, kind, dir, 'server'),
			port,
			logger: warnLog(warnings),
		})
		const legacy = makeApp(old, join(dir, 'legacy.db'), { url })
		const modern = makeApp(cur, join(dir, 'modern.db'), { url })
		const apps = [legacy, modern]
		const seen = [...watch(legacy, 'legacy'), ...watch(modern, 'modern')]
		try {
			await legacy.ready
			await modern.ready
			await legacy.sync.connect()
			await modern.sync.connect()
			const ids = await writeShapes(legacy, old, 'L')
			await writeShapes(modern, cur, 'M')
			// Concurrent increments on one record from both builds, and a legacy cascade over a
			// child the modern client created.
			await until(async () => (await modern.notes.findById(ids.a)) !== null, 'legacy row on modern')
			await Promise.all([
				legacy.notes.update(ids.a, { n: old.core.op.increment(10) }),
				modern.notes.update(ids.a, { n: cur.core.op.increment(100) }),
			])
			const shared = await modern.projects.insert({ name: 'shared' })
			const modernChild = await modern.notes.insert({
				title: 'modern-child',
				body: yText('m'),
				projectId: shared.id,
			})
			await until(
				async () => (await legacy.projects.findById(shared.id)) !== null,
				'shared project on legacy',
			)
			await until(
				async () => (await legacy.notes.findById(modernChild.id)) !== null,
				'modern child on legacy',
			)
			await legacy.projects.delete(shared.id)
			await settleAll(apps)
			const peer = makeApp(cur, join(dir, 'peer.db'), { url })
			apps.push(peer)
			seen.push(...watch(peer, 'peer'))
			await peer.ready
			await peer.sync.connect()
			const snaps = await converge(apps, 'legacy, modern and a fresh peer converge')
			const a = (await peer.notes.findById(ids.a)) ?? {}
			const childGone = (await peer.notes.findById(modernChild.id)) === null
			const rejected = [
				...((await legacy.sync.getRejectedOperations?.()) ?? []),
				...((await modern.sync.getRejectedOperations?.()) ?? []),
			].map((r) => r.code ?? r.reason)
			const problems = seen.filter((e) => e.type !== 'sync:protocol-deprecated')
			const serverOps =
				kind === 'memory' ? store.getAllOperations().length : await store.getOperationCount()
			return {
				ok: rejected.length === 0 && problems.length === 0 && childGone && a.n === 113,
				records: Object.keys(snaps[0]).length,
				serverOps,
				n: a.n,
				legacyCascadeOfModernChild: childGone,
				rejected,
				events: problems.slice(0, 5),
				serverWarnings: [...new Set(warnings)],
			}
		} finally {
			for (const app of apps) await app.close()
			await server.stop()
		}
	})
}

for (const kind of ['memory', 'sqlite']) {
	await scenario(`shapes/current-client/b12-server/${kind}`, async (dir) => {
		const port = await freePort()
		const { server, url } = await makeServer(old, old.kora, {
			store: await serverStoreFor(old, kind, dir, 'server'),
			port,
		})
		const legacy = makeApp(old, join(dir, 'legacy.db'), { url })
		const m1 = makeApp(cur, join(dir, 'm1.db'), { url })
		const m2 = makeApp(cur, join(dir, 'm2.db'), { url })
		const apps = [m1, m2, legacy]
		const seen = [...watch(m1, 'm1'), ...watch(m2, 'm2'), ...watch(legacy, 'legacy')]
		try {
			for (const app of apps) await app.ready
			for (const app of apps) await app.sync.connect()
			const ids = await writeShapes(m1, cur, 'M1')
			await writeShapes(legacy, old, 'L')
			await until(async () => (await m2.notes.findById(ids.a)) !== null, 'row on m2')
			await Promise.all([
				m1.notes.update(ids.a, { n: cur.core.op.increment(10) }),
				m2.notes.update(ids.a, { n: cur.core.op.increment(100) }),
			])
			await settleAll(apps)
			const peer = makeApp(cur, join(dir, 'peer.db'), { url })
			apps.push(peer)
			seen.push(...watch(peer, 'peer'))
			await peer.ready
			await peer.sync.connect()
			// Current replicas must agree exactly (the beta.12 client keeps beta.12 merge
			// semantics; compared separately on the fields no concurrent writer touched).
			const snaps = await converge(
				[m1, m2, peer],
				'current clients converge through a beta.12 server',
			)
			const legacySnap = await snapshot(legacy)
			const legacyDiffs = diffSnapshots(snaps[0], legacySnap)
			const a = (await m2.notes.findById(ids.a)) ?? {}
			const rejected = [
				...((await m1.sync.getRejectedOperations?.()) ?? []),
				...((await m2.sync.getRejectedOperations?.()) ?? []),
			].map((r) => r.code ?? r.reason)
			return {
				ok: rejected.length === 0 && seen.length === 0 && a.n === 113,
				records: Object.keys(snaps[0]).length,
				n: a.n,
				rejected,
				events: seen.slice(0, 5),
				legacyDiffers: legacyDiffs.length,
				legacyDiffSample: legacyDiffs.slice(0, 2),
			}
		} finally {
			for (const app of apps) await app.close()
			await server.stop()
		}
	})
}

// ---------------------------------------------------------------- client database upgrade

for (const mode of ['offline', 'synced-b12-server', 'synced-current-server']) {
	await scenario(`upgrade/client-db/${mode}`, async (dir) => {
		const file = join(dir, 'device.db')
		const servers = []
		const apps = []
		try {
			let url = null
			let oldServer = null
			if (mode !== 'offline') {
				const port = await freePort()
				const pkg = mode === 'synced-b12-server' ? old : cur
				const started = await makeServer(pkg, pkg.kora, {
					store: await serverStoreFor(pkg, 'sqlite', dir, 'server'),
					port,
				})
				servers.push(started.server)
				url = started.url
				oldServer = started
			}
			const legacy = makeApp(old, file, url ? { url } : {})
			await legacy.ready
			if (url) await legacy.sync.connect()
			const ids = await writeShapes(legacy, old, 'L')
			await sleep(url ? 1500 : 50)
			const before = await snapshot(legacy)
			await legacy.close()

			// Upgrade: the device opens its beta.12 database with this release. With a beta.12
			// server, the server is upgraded too (same database file).
			let finalUrl = url
			if (mode === 'synced-b12-server') {
				await oldServer.server.stop()
				servers.length = 0
				const port = await freePort()
				const started = await makeServer(cur, cur.kora, {
					store: cur.server.createSqliteServerStore({ filename: join(dir, 'server.sqlite') }),
					port,
				})
				servers.push(started.server)
				finalUrl = started.url
			} else if (mode === 'offline') {
				const port = await freePort()
				const started = await makeServer(cur, cur.kora, { port })
				servers.push(started.server)
				finalUrl = started.url
			}
			const upgraded = makeApp(cur, file, { url: finalUrl })
			apps.push(upgraded)
			const seen = watch(upgraded, 'upgraded')
			await upgraded.ready
			const afterOpen = await snapshot(upgraded)
			const localDiffs = diffSnapshots(before, afterOpen)
			await upgraded.sync.connect()
			const peer = makeApp(cur, join(dir, 'peer.db'), { url: finalUrl })
			apps.push(peer)
			seen.push(...watch(peer, 'peer'))
			await peer.ready
			await peer.sync.connect()
			await converge([upgraded, peer], 'upgraded device and a fresh peer converge')
			// The write that beta.12 numbered like the transaction before it must reach peers.
			const afterTx = await peer.notes.findById(ids.afterTx)
			const rejectedFull = (await upgraded.sync.getRejectedOperations?.()) ?? []
			const rejected = rejectedFull.map((r) => r.code ?? r.reason)
			if (process.env.COMPAT_VERBOSE)
				for (const r of rejectedFull) console.error('[rejected]', JSON.stringify(r).slice(0, 2000))
			return {
				ok:
					localDiffs.length === 0 && afterTx !== null && rejected.length === 0 && seen.length === 0,
				records: Object.keys(afterOpen).length,
				localDiffs: localDiffs.slice(0, 3),
				afterTxReachedPeer: afterTx !== null,
				rejected,
				events: seen.slice(0, 5),
			}
		} finally {
			for (const app of apps) await app.close()
			for (const s of servers) await s.stop()
		}
	})
}

// ---------------------------------------------------------------- server database upgrade

const TOKENS = { 'tok-u1': 'u1', 'tok-u2': 'u2' }
function authFor(pkg, mode) {
	if (mode === 'none') return undefined
	const primary = new pkg.server.TokenAuthProvider({
		validate: async (token) => (TOKENS[token] ? { userId: TOKENS[token] } : null),
	})
	if (mode === 'token') return primary
	return new pkg.server.MixedAuthProvider({ primary, anonymousScopes: { notes: {}, projects: {} } })
}

for (const kind of ['sqlite', 'postgres']) {
	for (const authMode of ['none', 'token', 'anonymous']) {
		await scenario(`upgrade/server-db/${kind}/${authMode}`, async (dir) => {
			if (kind === 'postgres' && !PG_URL) return { skipped: 'KORA_PG_TEST_URL not set' }
			if (kind === 'postgres') await resetPg()
			const token = authMode === 'none' ? undefined : authMode === 'token' ? 'tok-u1' : ''
			const servers = []
			const apps = []
			try {
				// beta.12 server and two beta.12 devices write history.
				const port1 = await freePort()
				const s1 = await makeServer(old, old.kora, {
					store: await serverStoreFor(old, kind, dir, 'server'),
					port: port1,
					auth: authFor(old, authMode),
				})
				servers.push(s1.server)
				const d1 = makeApp(old, join(dir, 'd1.db'), { url: s1.url, token })
				const d2 = makeApp(old, join(dir, 'd2.db'), {
					url: s1.url,
					token: authMode === 'token' ? 'tok-u2' : token,
				})
				for (const d of [d1, d2]) {
					await d.ready
					await d.sync.connect()
				}
				const ids = await writeShapes(d1, old, 'D1')
				await until(async () => (await d2.notes.findById(ids.a)) !== null, 'd1 row on d2 (beta.12)')
				await d2.notes.update(ids.a, { n: old.core.op.increment(5) })
				await settleAll([d1, d2])
				await sleep(800)
				// Both devices then write offline: unsynced beta.12 writes that must survive the
				// server upgrade (d1 stays on beta.12, d2 upgrades its database).
				await d1.sync.disconnect()
				await d2.sync.disconnect()
				const offline1 = await d1.notes.insert({ title: 'd1-offline', body: yText('o1') })
				const offline2 = await d2.notes.insert({ title: 'd2-offline', body: yText('o2') })
				// The writer's view: beta.12 peers never saw an `undefined` clear (the JSON wire
				// drops the member), so d2 differs from d1 there. The upgraded server stores the
				// clear the writer applied (RT-71), so every replica ends at the writer's row.
				const historic = await snapshot(d1)
				const peerBeta12 = diffSnapshots(historic, await snapshot(d2)).filter(
					(d) => d.a !== null && d.b !== null,
				)
				await d1.close()
				await d2.close()
				await s1.server.stop()
				servers.length = 0
				if (kind === 'sqlite') await s1.store.close?.()

				// This release opens the beta.12 server database.
				const warnings = []
				const port2 = await freePort()
				const s2 = await makeServer(cur, cur.kora, {
					store: await serverStoreFor(cur, kind, dir, 'server'),
					port: port2,
					auth: authFor(cur, authMode),
					logger: warnLog(warnings),
				})
				servers.push(s2.server)
				// d1 stays on beta.12 (protocol 1); d2 upgrades its database; a fresh device joins.
				const r1 = makeApp(old, join(dir, 'd1.db'), { url: s2.url, token })
				const r2 = makeApp(cur, join(dir, 'd2.db'), {
					url: s2.url,
					token: authMode === 'token' ? 'tok-u2' : token,
				})
				const fresh = makeApp(cur, join(dir, 'fresh.db'), { url: s2.url, token })
				apps.push(r1, r2, fresh)
				const seen = [
					...watch(r1, 'b12-device'),
					...watch(r2, 'upgraded-device'),
					...watch(fresh, 'fresh'),
				]
				for (const a of apps) await a.ready
				for (const a of apps) await a.sync.connect()
				// New writes after the upgrade, from both builds.
				await sleep(500)
				const postLegacy = await r1.notes.insert({ title: 'after-upgrade-b12', body: yText('x') })
				const postModern = await r2.notes.insert({
					title: 'after-upgrade-current',
					body: yText('y'),
				})
				// A signed-in user's beta.12 node has history and no claim: refused until an admin
				// releases it (RT-5; beta.12 clients cannot rotate). The documented operator path.
				let refusedUntilReleased = null
				if (authMode === 'token') {
					await sleep(1500)
					refusedUntilReleased = r1.sync.getStatus?.()?.phase !== 'streaming'
					const nodeId = r1.getStore?.()?.getNodeId?.()
					if (nodeId) await s2.server.releaseNodeClaim(nodeId)
				}
				let convergeError = null
				try {
					await converge(
						[r1, r2, fresh],
						'beta.12 device, upgraded device and fresh device converge',
						30000,
					)
				} catch (e) {
					convergeError = String(e.message).slice(0, 600)
				}
				const freshSnap = await snapshot(fresh)
				const historyDiffs = diffSnapshots(historic, freshSnap).filter(
					(d) => d.a !== null, // rows written after the upgrade are new
				)
				const brief = (st) => {
					if (!st) return null
					const err = st.lastError ?? st.error ?? st.blockedFailure ?? st.reason
					return {
						phase: st.phase ?? st.status,
						...(err
							? { error: String(err?.code ?? err?.message ?? JSON.stringify(err)).slice(0, 200) }
							: {}),
					}
				}
				const statuses = {
					b12: brief(r1.sync.getStatus?.()),
					upgraded: brief(r2.sync.getStatus?.()),
					fresh: brief(fresh.sync.getStatus?.()),
				}
				if (process.env.COMPAT_VERBOSE) {
					console.error('[status b12]', JSON.stringify(r1.sync.getStatus?.()).slice(0, 1500))
					console.error('[status upgraded]', JSON.stringify(r2.sync.getStatus?.()).slice(0, 1500))
				}
				const rejected = [
					...((await r1.sync.getRejectedOperations?.()) ?? []),
					...((await r2.sync.getRejectedOperations?.()) ?? []),
				].map((r) => r.code ?? r.reason)
				const problems = seen.filter((e) => e.type !== 'sync:protocol-deprecated')
				const offlineArrived = {
					b12Device: (await fresh.notes.findById(offline1.id)) !== null,
					upgradedDevice: (await fresh.notes.findById(offline2.id)) !== null,
				}
				return {
					ok:
						convergeError === null &&
						historyDiffs.length === 0 &&
						offlineArrived.b12Device &&
						offlineArrived.upgradedDevice &&
						(await fresh.notes.findById(postLegacy.id)) !== null &&
						(await fresh.notes.findById(postModern.id)) !== null &&
						rejected.length === 0,
					convergeError,
					...(refusedUntilReleased !== null
						? { b12RefusedUntilAdminRelease: refusedUntilReleased }
						: {}),
					offlineArrived,
					beta12PeerDiffsBeforeUpgrade: peerBeta12.length,
					historyDiffs: historyDiffs.slice(0, 3),
					statuses,
					rejected,
					events: problems.slice(0, 6),
					serverWarnings: [...new Set(warnings)],
				}
			} finally {
				for (const a of apps) await a.close()
				for (const s of servers) await s.stop()
			}
		})
	}
}

// ---------------------------------------------------------------- mixed fleets under chaos

async function randomWrites(app, pkg, random, count, tag, known) {
	const op = pkg.core.op
	for (let i = 0; i < count; i++) {
		const r = random()
		const notes = known.notes
		const pick = () => notes[Math.floor(random() * notes.length)]
		try {
			if (r < 0.2 || notes.length < 3) {
				const row = await app.notes.insert({
					title: `${tag}-${i} ü😀`,
					n: Math.floor(random() * 5),
					tags: random() < 0.5 ? ['a'] : [],
					meta: { a: i, b: random() < 0.5 ? undefined : 's' },
					extra: { at: new Date(1700000000000 + i), k: [i] },
					due: 1700000000000 + i * 1000,
					body: yText(`${tag}-${i}`),
					projectId: known.projects[Math.floor(random() * known.projects.length)],
				})
				notes.push(row.id)
			} else if (r < 0.4) {
				await app.notes.update(pick(), { n: op.increment(1) })
			} else if (r < 0.5) {
				await app.notes.update(pick(), {
					title: `${tag}-t${i}`,
					assignee: random() < 0.5 ? undefined : 'z',
				})
			} else if (r < 0.58) {
				await app.notes.update(pick(), { tags: random() < 0.5 ? ['a', tag] : [tag] })
			} else if (r < 0.64) {
				await app.notes.update(pick(), {
					meta: { a: i, b: undefined },
					extra: { at: new Date(), v: i },
				})
			} else if (r < 0.72) {
				await app.transaction(async (tx) => {
					const row = await tx.notes.insert({ title: `${tag}-tx${i}`, body: yText('tx') })
					await tx.notes.update(row.id, { n: 3 })
					notes.push(row.id)
				})
				// beta.12: shares the transaction's last sequence number (STORE-1).
				await app.notes.update(pick(), { n: op.increment(1) })
			} else if (r < 0.78) {
				await app.notes.delete(pick())
			} else if (r < 0.82) {
				const p = await app.projects.insert({ name: `${tag}-p${i}` })
				known.projects.push(p.id)
			} else if (r < 0.85 && known.projects.length > 2) {
				const victim = known.projects.splice(Math.floor(random() * known.projects.length), 1)[0]
				await app.projects.delete(victim)
			} else {
				await app.notes.update(pick(), { due: 1700000000000 + i })
			}
		} catch (error) {
			// Writes to records another replica deleted are refused locally (RecordNotFound).
			if (!/not found|NOT_FOUND/i.test(String(error?.message ?? error))) throw error
		}
		if (random() < 0.3) await sleep(Math.floor(random() * 20))
	}
}

/** Verbose: the logs and provisional effects behind the first diverging record. */
async function dumpDivergence(apps) {
	const snaps = await Promise.all(apps.map((a) => snapshot(a)))
	const diff = snaps.slice(1).flatMap((s) => diffSnapshots(snaps[0], s))[0]
	if (!diff) return
	const [collection, recordId] = diff.key.split('/')
	for (const [i, app] of apps.entries()) {
		const store = app.getStore?.()
		const ops = (await store?.getOperationsForRecord?.(collection, recordId)) ?? []
		const adapter = store?.adapter ?? store?.getAdapter?.()
		let provisional = []
		try {
			provisional =
				(await adapter?.query?.('SELECT * FROM _kora_provisional_ops WHERE record_id = ?', [
					recordId,
				])) ?? []
		} catch {}
		console.error(`[divergence ${diff.key}] replica ${i} node=${store?.getNodeId?.()}`)
		for (const o of ops) {
			console.error(
				'   op',
				o.id.slice(0, 10),
				o.type,
				o.nodeId.slice(-6),
				o.sequenceNumber,
				JSON.stringify(o.timestamp),
				JSON.stringify(o.data)?.slice(0, 120),
				(o.causalDeps ?? []).map((d) => d.slice(0, 8)).join(','),
			)
		}
		for (const p of provisional) console.error('   provisional', JSON.stringify(p).slice(0, 400))
		const parentId = JSON.parse(snaps[0][diff.key] ?? snaps[i][diff.key] ?? '{}').projectId
		if (parentId) {
			const pops = (await store?.getOperationsForRecord?.('projects', parentId)) ?? []
			for (const o of pops)
				console.error(
					'   parent',
					o.id.slice(0, 10),
					o.type,
					o.nodeId.slice(-6),
					JSON.stringify(o.timestamp),
				)
		}
	}
}

for (const serverBuild of ['current-server', 'b12-server']) {
	for (const seed of SEEDS) {
		await scenario(`chaos/${serverBuild}/seed-${seed}`, async (dir) => {
			const random = rng(seed * 7919)
			chaosState.random = rng(seed * 104729)
			const pkgServer = serverBuild === 'current-server' ? cur : old
			const port = await freePort()
			const { server, url } = await makeServer(pkgServer, pkgServer.kora, {
				store: await serverStoreFor(pkgServer, 'sqlite', dir, 'server'),
				port,
			})
			const fleet = [
				{ name: 'b12-a', pkg: old },
				{ name: 'b12-b', pkg: old },
				{ name: 'cur-a', pkg: cur },
				{ name: 'cur-b', pkg: cur },
			]
			const apps = []
			const seen = []
			try {
				for (const f of fleet) {
					f.app = makeApp(f.pkg, join(dir, `${f.name}.db`), { url })
					apps.push(f.app)
					seen.push(...watch(f.app, f.name))
					await f.app.ready
				}
				// Seed shared records without chaos, so every replica edits the same rows.
				for (const f of fleet) await f.app.sync.connect()
				const seedApp = fleet[2].app
				const known = { notes: [], projects: [] }
				for (let i = 0; i < 3; i++)
					known.projects.push((await seedApp.projects.insert({ name: `p${i}` })).id)
				for (let i = 0; i < 6; i++) {
					known.notes.push(
						(
							await seedApp.notes.insert({
								title: `seed${i}`,
								body: yText('s'),
								projectId: known.projects[i % 3],
							})
						).id,
					)
				}
				await converge(apps, 'seed rows everywhere')
				for (const f of fleet) await f.app.sync.disconnect()
				chaosState.enabled = true
				for (const f of fleet) await f.app.sync.connect()
				// Rounds of concurrent writes under chaos, with offline stretches.
				for (let round = 0; round < 3; round++) {
					await Promise.all(
						fleet.map(async (f, idx) => {
							const mine = { notes: [...known.notes], projects: [...known.projects] }
							if (random() < 0.3) await f.app.sync.disconnect()
							await randomWrites(
								f.app,
								f.pkg,
								rng(seed * 31 + round * 7 + idx),
								25,
								`${f.name}r${round}`,
								mine,
							)
							for (const id of mine.notes) if (!known.notes.includes(id)) known.notes.push(id)
							if (!f.app.sync.getStatus?.() || f.app.sync.getStatus().phase === 'offline') {
								await f.app.sync.connect().catch(() => {})
							}
						}),
					)
					await sleep(300)
				}
				// Heal: no more faults; reconnect everyone so dropped frames are re-sent.
				chaosState.calm = true
				for (const f of fleet) {
					await f.app.sync.disconnect().catch(() => {})
					await f.app.sync.connect()
				}
				await settleAll(apps, 5000)
				const modern = fleet.filter((f) => f.pkg === cur).map((f) => f.app)
				const peer = makeApp(cur, join(dir, 'peer.db'), { url })
				apps.push(peer)
				seen.push(...watch(peer, 'peer'))
				await peer.ready
				await peer.sync.connect()
				let modernError = null
				let snaps = []
				try {
					snaps = await converge([...modern, peer], 'current replicas converge', 60000)
				} catch (e) {
					modernError = String(e.message).slice(0, 600)
					if (process.env.COMPAT_VERBOSE) await dumpDivergence([...modern, peer])
				}
				// The beta.12 replicas, then the same devices after upgrading their databases.
				const legacyDiffs = []
				for (const f of fleet.filter((x) => x.pkg === old)) {
					legacyDiffs.push(diffSnapshots(snaps[0] ?? {}, await snapshot(f.app)).length)
				}
				for (const f of fleet.filter((x) => x.pkg === old)) {
					await f.app.close()
					apps.splice(apps.indexOf(f.app), 1)
					f.app = makeApp(cur, join(dir, `${f.name}.db`), { url })
					apps.push(f.app)
					seen.push(...watch(f.app, `${f.name}-upgraded`))
					await f.app.ready
					await f.app.sync.connect()
				}
				let upgradedError = null
				try {
					await converge(
						[...fleet.map((f) => f.app), peer],
						'every replica converges after the beta.12 devices upgrade',
						60000,
					)
				} catch (e) {
					upgradedError = String(e.message).slice(0, 600)
				}
				const rejected = []
				for (const f of fleet)
					rejected.push(
						...((await f.app.sync.getRejectedOperations?.()) ?? []).map((r) => r.code ?? r.reason),
					)
				const problems = seen.filter(
					(e) => e.type !== 'sync:protocol-deprecated' && e.type !== 'sync:error',
				)
				return {
					ok: modernError === null && upgradedError === null && problems.length === 0,
					records: Object.keys(snaps[0] ?? {}).length,
					modernError,
					legacyDiffsBeforeUpgrade: legacyDiffs,
					upgradedError,
					rejected: [...new Set(rejected)],
					events: problems.slice(0, 6),
					transientErrors: seen.filter((e) => e.type === 'sync:error').length,
				}
			} finally {
				chaosState.enabled = false
				for (const app of apps) await app.close().catch(() => {})
				await server.stop()
			}
		})
	}
}

// ---------------------------------------------------------------- encryption

for (const policy of ['optional', 'required', 'migration']) {
	await scenario(`encryption/b12-client/current-server/${policy}`, async (dir) => {
		const warnings = []
		const port = await freePort()
		const { server, store, url } = await makeServer(cur, cur.kora, {
			port,
			onDelete: 'no-action',
			logger: warnLog(warnings),
			...(policy === 'optional'
				? {}
				: {
						encryption: {
							required: true,
							...(policy === 'migration' ? { allowPlaintextMigration: true } : {}),
						},
					}),
		})
		const encryption = { enabled: true, key: 'shared passphrase' }
		// Enforced foreign keys must be cleartext under encryption in this release; the
		// relation is declared no-action so both builds accept the same schema.
		const legacy = makeApp(old, join(dir, 'legacy.db'), { url, encryption, onDelete: 'no-action' })
		const modern = makeApp(cur, join(dir, 'modern.db'), { url, encryption, onDelete: 'no-action' })
		const modern2 = makeApp(cur, join(dir, 'modern2.db'), {
			url,
			encryption,
			onDelete: 'no-action',
		})
		const apps = [legacy, modern, modern2]
		const seen = [
			...watch(legacy, 'legacy'),
			...watch(modern, 'modern'),
			...watch(modern2, 'modern2'),
		]
		try {
			for (const a of apps) await a.ready
			for (const a of apps) await a.sync.connect()
			const row = await legacy.notes.insert({ title: 'secret', body: yText('s') })
			const mine = await modern.notes.insert({ title: 'modern secret', body: yText('m') })
			await settleAll(apps)
			await sleep(1500)
			const onModern = await modern.notes.findById(row.id)
			const onLegacy = await legacy.notes.findById(mine.id)
			const onModern2 = await modern2.notes.findById(mine.id)
			const stored = store.getAllOperations().filter((o) => o.recordId === row.id)
			const rejected = ((await legacy.sync.getRejectedOperations?.()) ?? []).map(
				(r) => r.code ?? r.reason,
			)
			// The beta.12 device then upgrades its database (same passphrase).
			await legacy.close()
			apps.splice(apps.indexOf(legacy), 1)
			const upgraded = makeApp(cur, join(dir, 'legacy.db'), {
				url,
				encryption,
				onDelete: 'no-action',
			})
			apps.push(upgraded)
			seen.push(...watch(upgraded, 'upgraded'))
			await upgraded.ready
			await upgraded.sync.connect()
			const afterUpgrade = await upgraded.notes.insert({ title: 'after upgrade', body: yText('u') })
			await settleAll(apps)
			await sleep(1500)
			return {
				ok: true, // observation row: the outcome is documented, not asserted
				legacyReachedModern: onModern?.title ?? null,
				modernReachedLegacy: onLegacy?.title ?? null,
				modernReachedModern: onModern2?.title ?? null,
				serverStoredLegacyOp: stored.length,
				legacyRejected: rejected,
				upgradedLegacyLocalRow: (await upgraded.notes.findById(row.id))?.title ?? null,
				upgradedOldWriteReachedModern: (await modern.notes.findById(row.id))?.title ?? null,
				upgradedNewWriteReachedModern:
					(await modern.notes.findById(afterUpgrade.id))?.title ?? null,
				events: seen.slice(0, 6),
				serverWarnings: [...new Set(warnings)],
			}
		} finally {
			for (const a of apps) await a.close()
			await server.stop()
		}
	})
}

await scenario('encryption/current-clients/b12-server', async (dir) => {
	const port = await freePort()
	const { server, url } = await makeServer(old, old.kora, { port, onDelete: 'no-action' })
	const encryption = { enabled: true, key: 'shared passphrase' }
	const a = makeApp(cur, join(dir, 'a.db'), { url, encryption, onDelete: 'no-action' })
	const b = makeApp(cur, join(dir, 'b.db'), { url, encryption, onDelete: 'no-action' })
	const seen = [...watch(a, 'a'), ...watch(b, 'b')]
	try {
		for (const x of [a, b]) await x.ready
		for (const x of [a, b]) await x.sync.connect()
		const row = await a.notes.insert({ title: 'secret', body: yText('s') })
		await settleAll([a, b])
		await sleep(1500)
		return {
			ok: true, // observation row
			reachedPeer: (await b.notes.findById(row.id))?.title ?? null,
			rejected: ((await a.sync.getRejectedOperations?.()) ?? []).map((r) => r.code ?? r.reason),
			events: seen.slice(0, 6),
		}
	} finally {
		await a.close()
		await b.close()
		await server.stop()
	}
})

process.exit(results.every(Boolean) ? 0 : 1)
