#!/usr/bin/env node
/**
 * Browser half of the beta.12 compatibility matrix: a database written by the real
 * 1.0.0-beta.12 app (tag v1.0.0-beta.12) in real Chromium, opened by this release.
 *
 * For each storage path (SQLite WASM on OPFS, where beta.12 kept every database in one
 * origin-wide `kora-opfs` pool, and the IndexedDB fallback) the beta.12 page writes the
 * full write workload (inserts, `undefined` clears, increments, arrays, objects, a Date in
 * a json value, unicode, transactions with beta.12's shared sequence numbers, a cascade,
 * a delete), closes, and a page of this release opens the same database: every row must
 * read back unchanged. The upgraded page then syncs to a server of this release next to a
 * Node peer, which must converge with it, including the write beta.12 numbered like the
 * transaction before it (STORE-1).
 *
 * Usage (after `pnpm build` here and in the beta.12 tree):
 *   PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/remediation/compat-beta12-browser.mjs <beta12-build>
 * Prints one JSON line per scenario; exit 1 on any failure.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(fileURLToPath(import.meta.url), '../../..')
const b12 = process.argv[2] ? resolve(process.argv[2]) : null
if (!b12) {
	console.error('usage: compat-beta12-browser.mjs <path-to-beta12-build>')
	process.exit(2)
}
const requireHere = createRequire(join(here, 'package.json'))
const esbuild = createRequire(requireHere.resolve('tsup'))('esbuild')
const { chromium } = createRequire(join(here, 'e2e/package.json'))('@playwright/test')
const cur = {
	kora: await import(join(here, 'kora/dist/index.js')),
	server: await import(join(here, 'packages/server/dist/index.js')),
}

const out = mkdtempSync(join(tmpdir(), 'kora-compat-b12-browser-'))

/** The page script: one workload, run by whichever build the entry imports. */
const pageSource = (koraPath, corePath, tag) => `
import { createApp, defineSchema, t } from ${JSON.stringify(koraPath)}
import { op } from ${JSON.stringify(corePath)}

const schema = defineSchema({
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
		noteProject: { from: 'notes', to: 'projects', type: 'many-to-one', field: 'projectId', onDelete: 'cascade' },
	},
})

let app = null
const events = []
function canonical(value) {
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
	if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
		return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined && value[k] !== null)
			.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
	}
	if (value instanceof Uint8Array) return JSON.stringify('<bytes ' + value.length + '>')
	return JSON.stringify(value ?? null)
}
async function snapshot() {
	const out = {}
	for (const collection of ['projects', 'notes']) {
		for (const row of await app[collection].where({}).exec()) {
			const { createdAt, updatedAt, body, ...rest } = row
			out[collection + '/' + row.id] = canonical(rest)
		}
	}
	return out
}
window.K = {
	tag: ${JSON.stringify(tag)},
	events,
	async open(adapter, name, url) {
		app = createApp({
			schema,
			store: { adapter, name, workerUrl: '/${tag}-worker.js' },
			...(url ? { sync: { url } } : {}),
		})
		for (const type of ['store:storage-migrated', 'store:rematerialized', 'sync:operation-rejected', 'sync:apply-failed', 'store:persistence-error']) {
			try { app.events.on(type, (e) => events.push({ type, code: e?.code ?? e?.mode ?? null })) } catch {}
		}
		await app.ready
		return true
	},
	async writeShapes() {
		const ids = {}
		const p = await app.projects.insert({ name: 'p' })
		const a = await app.notes.insert({
			title: 'é😀\\u2028 x', assignee: 'bob', meta: { a: 1, b: undefined }, n: 1, tags: ['b', 'a', 'a'],
			extra: { when: new Date(1700000000000), z: [1, { b: 2, a: 0.1 + 0.2 }] }, due: 1700000000123,
			body: 'body', projectId: p.id,
		})
		ids.a = a.id
		await app.notes.update(a.id, { assignee: undefined, title: 'cleared' })
		await app.notes.update(a.id, { n: op.increment(2) })
		await app.notes.update(a.id, { meta: { a: 2, b: undefined }, tags: ['x', 'y'] })
		let tx
		await app.transaction(async (t) => {
			tx = await t.notes.insert({ title: 'tx', n: 5, body: 'tx', projectId: p.id })
			await t.notes.update(tx.id, { n: 6 })
		})
		ids.afterTx = (await app.notes.insert({ title: 'after-tx', body: 'after' })).id
		const doomed = await app.projects.insert({ name: 'doomed' })
		await app.notes.insert({ title: 'child', body: 'c', projectId: doomed.id })
		await app.projects.delete(doomed.id)
		const gone = await app.notes.insert({ title: 'deleted', body: 'd' })
		await app.notes.delete(gone.id)
		return ids
	},
	snapshot,
	async connect() { await app.sync.connect() },
	async rejected() { return ((await app.sync.getRejectedOperations?.()) ?? []).map((r) => r.code) },
	async close() { await app.close(); app = null; return true },
}
window.__ready = true
`

async function build() {
	const common = {
		bundle: true,
		format: 'esm',
		target: 'es2022',
		logLevel: 'error',
		platform: 'browser',
	}
	const builds = [
		{ tag: 'b12', root: b12 },
		{ tag: 'cur', root: here },
	]
	for (const { tag, root } of builds) {
		const entry = join(out, `${tag}-page-entry.js`)
		writeFileSync(
			entry,
			pageSource(join(root, 'kora/dist/index.js'), join(root, 'packages/core/dist/index.js'), tag),
		)
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
		// beta.12's worker loads the module from the default path (it predates the pin).
		if (tag === 'b12') writeFileSync(join(out, 'sqlite3.wasm'), await readFile(wasm))
		writeFileSync(
			join(out, `${tag}.html`),
			`<!doctype html><meta charset=utf-8><title>${tag}</title><script type=module src=/${tag}-page.js></script>`,
		)
	}
	const types = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' }
	const server = createServer(async (req, res) => {
		const p = join(out, new URL(req.url, 'http://x').pathname)
		try {
			const body = await readFile(p)
			res.writeHead(200, {
				'content-type': types[extname(p)] ?? 'application/octet-stream',
				'cross-origin-opener-policy': 'same-origin',
				'cross-origin-embedder-policy': 'require-corp',
			})
			res.end(body)
		} catch {
			if (process.env.COMPAT_VERBOSE) console.error('[404]', req.url)
			res.writeHead(404)
			res.end()
		}
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

function diff(a, b) {
	const out = []
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (a[key] !== b[key]) out.push({ key, a: a[key] ?? null, b: b[key] ?? null })
	}
	return out
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { server: http, origin } = await build()
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined })
const results = []

async function page(ctx, tag) {
	const p = await ctx.newPage()
	p.on('pageerror', (e) => console.error(`[${tag} pageerror]`, String(e).slice(0, 300)))
	await p.goto(`${origin}/${tag}.html`)
	await p.waitForFunction(() => window.__ready === true)
	return p
}

for (const adapter of ['sqlite-wasm', 'indexeddb']) {
	const name = `compat_${adapter.replace('-', '_')}`
	const scenario = `browser/${adapter}/b12-database-upgraded`
	const dir = mkdtempSync(join(tmpdir(), 'kora-compat-b12-peer-'))
	const ctx = await browser.newContext()
	let syncServer = null
	const nodeApps = []
	try {
		const legacy = await page(ctx, 'b12')
		await legacy.evaluate(([a, n]) => window.K.open(a, n), [adapter, name])
		const ids = await legacy.evaluate(() => window.K.writeShapes())
		const before = await legacy.evaluate(() => window.K.snapshot())
		await legacy.evaluate(() => window.K.close())
		await legacy.close()
		await sleep(500)

		const port = 49000 + Math.floor(Math.random() * 900)
		const store = new cur.server.MemoryServerStore()
		const schemaPage = await page(ctx, 'cur')
		// The server and the Node peer use the same schema as the pages (built in Node).
		const { t, defineSchema } = cur.kora
		const schema = defineSchema({
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
					onDelete: 'cascade',
				},
			},
		})
		await store.setSchema(schema)
		syncServer = cur.server.createKoraServer({ store, port })
		await syncServer.start()
		const url = `ws://127.0.0.1:${port}`

		await schemaPage.evaluate(([a, n, u]) => window.K.open(a, n, u), [adapter, name, url])
		const after = await schemaPage.evaluate(() => window.K.snapshot())
		const localDiffs = diff(before, after)
		await schemaPage.evaluate(() => window.K.connect())
		const peer = cur.kora.createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'peer.db') },
			sync: { url },
		})
		nodeApps.push(peer)
		await peer.ready
		await peer.sync.connect()
		let peerDiffs = []
		for (let i = 0; i < 100; i++) {
			await sleep(200)
			const rows = {}
			for (const collection of ['projects', 'notes']) {
				for (const row of await peer[collection].where({}).exec()) {
					const { createdAt: _c, updatedAt: _u, body: _b, ...rest } = row
					rows[`${collection}/${row.id}`] = await schemaPage.evaluate((r) => {
						// canonical() lives in the page; reuse it through snapshot's format
						const c = (v) =>
							Array.isArray(v)
								? `[${v.map(c).join(',')}]`
								: v !== null && typeof v === 'object'
									? `{${Object.keys(v)
											.sort()
											.filter((k) => v[k] !== undefined && v[k] !== null)
											.map((k) => `${JSON.stringify(k)}:${c(v[k])}`)
											.join(',')}}`
									: JSON.stringify(v ?? null)
						return c(r)
					}, rest)
				}
			}
			peerDiffs = diff(await schemaPage.evaluate(() => window.K.snapshot()), rows)
			if (peerDiffs.length === 0) break
		}
		const events = await schemaPage.evaluate(() => window.K.events)
		const rejected = await schemaPage.evaluate(() => window.K.rejected())
		const afterTxOnPeer = (await peer.notes.findById(ids.afterTx)) !== null
		const ok =
			localDiffs.length === 0 &&
			peerDiffs.length === 0 &&
			afterTxOnPeer &&
			rejected.length === 0 &&
			!events.some((e) => e.type === 'sync:operation-rejected' || e.type === 'sync:apply-failed')
		results.push(ok)
		console.log(
			JSON.stringify({
				scenario,
				ok,
				records: Object.keys(after).length,
				localDiffs: localDiffs.slice(0, 3),
				peerDiffs: peerDiffs.slice(0, 3),
				afterTxOnPeer,
				rejected,
				events,
			}),
		)
		await schemaPage.evaluate(() => window.K.close())
	} catch (error) {
		results.push(false)
		console.log(
			JSON.stringify({ scenario, ok: false, error: String(error?.stack ?? error).slice(0, 1500) }),
		)
	} finally {
		for (const a of nodeApps) await a.close().catch(() => {})
		await syncServer?.stop()
		await ctx.close()
		rmSync(dir, { recursive: true, force: true })
	}
}

await browser.close()
http.close()
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
rmSync(out, { recursive: true, force: true })
process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1)
