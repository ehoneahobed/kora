#!/usr/bin/env node
/**
 * Protocol v2 wire-compatibility check against the last published release, 1.0.0-beta.12
 * (tag v1.0.0-beta.12, protocol 1). The unreleased Phase 1 build (33bca46) also works as
 * the legacy build, but no such client or server exists in the field.
 *
 * Usage:
 *   git archive v1.0.0-beta.12 | tar -x -C /tmp/b12 && (cd /tmp/b12 && pnpm install && pnpm build)
 *   node scripts/remediation/protocol-v2-compat.mjs /tmp/b12
 *
 * Runs two scenarios over real WebSockets with better-sqlite3 client stores:
 *   A. v2 clients (this tree) <-> beta.12 server: inserts and updates converge.
 *   B. beta.12 (protocol 1) client <-> v2 server (this tree), with a v2 client: the
 *      legacy client is accepted (deprecation warning), its writes reach the v2
 *      client, and the v2 client's writes reach it.
 * Prints one JSON line per scenario and exits non-zero on any failure.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(fileURLToPath(import.meta.url), '../../..')
const b12 = process.argv[2]
if (!b12) {
	console.error('usage: protocol-v2-compat.mjs <path-to-beta12-build>')
	process.exit(2)
}

const v2 = {
	kora: await import(join(here, 'kora/dist/index.js')),
	server: await import(join(here, 'packages/server/dist/index.js')),
}
const old = {
	kora: await import(join(b12, 'kora/dist/index.js')),
	server: await import(join(b12, 'packages/server/dist/index.js')),
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, ms = 15000) {
	const end = Date.now() + ms
	while (Date.now() < end) {
		if (await fn()) return
		await sleep(100)
	}
	throw new Error(`timeout: ${label}`)
}

function schemaOf(kora) {
	return kora.defineSchema({
		version: 1,
		collections: { notes: { fields: { title: kora.t.string(), n: kora.t.number().default(0) } } },
	})
}

async function startServer(serverPkg, kora, port, warnings) {
	const store = new serverPkg.MemoryServerStore()
	await store.setSchema(schemaOf(kora))
	const server = serverPkg.createKoraServer({
		store,
		port,
		...(warnings
			? {
					logger: {
						log: (e) => {
							if (e.level === 'warn') warnings.push(e.event)
						},
					},
				}
			: {}),
	})
	await server.start()
	return { server, store }
}

function client(kora, dir, name, port) {
	return kora.createApp({
		schema: schemaOf(kora),
		store: { adapter: 'better-sqlite3', name: join(dir, `${name}.db`) },
		sync: { url: `ws://127.0.0.1:${port}` },
	})
}

async function scenario(name, run) {
	const dir = mkdtempSync(join(tmpdir(), 'kora-compat-'))
	try {
		const details = await run(dir)
		console.log(JSON.stringify({ scenario: name, ok: true, ...details }))
		return true
	} catch (error) {
		console.log(JSON.stringify({ scenario: name, ok: false, error: String(error?.stack ?? error) }))
		return false
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const results = []

results.push(
	await scenario('v2 clients <-> beta.12 server', async (dir) => {
		const port = 47600 + Math.floor(Math.random() * 200)
		const { server, store } = await startServer(old.server, old.kora, port)
		const a = client(v2.kora, dir, 'a', port)
		const b = client(v2.kora, dir, 'b', port)
		await a.ready
		await b.ready
		await a.sync.connect()
		await b.sync.connect()
		const row = await a.notes.insert({ title: 'from-v2-a' })
		await until(async () => (await b.notes.findById(row.id))?.title === 'from-v2-a', 'insert A->B')
		await b.notes.update(row.id, { title: 'edited-by-b' })
		await until(
			async () => (await a.notes.findById(row.id))?.title === 'edited-by-b',
			'update B->A',
		)
		const stored = store.getAllOperations()
		const quarantinedA = (await a.sync.getQuarantinedOperations?.())?.length ?? 0
		const quarantinedB = (await b.sync.getQuarantinedOperations?.())?.length ?? 0
		await a.close()
		await b.close()
		await server.stop()
		if (quarantinedA + quarantinedB > 0) throw new Error('operations quarantined')
		return {
			serverOps: stored.length,
			// A beta.12 (or older) server drops the v2-only fields (hashVersion): relayed ops are
			// then treated as version 1 by v2 clients (not verified), never quarantined.
			serverKeptHashVersion: stored.some((o) => o.hashVersion === 2),
		}
	}),
)

results.push(
	await scenario('beta.12 client + v2 client <-> v2 server', async (dir) => {
		const port = 47800 + Math.floor(Math.random() * 200)
		const warnings = []
		const { server, store } = await startServer(v2.server, v2.kora, port, warnings)
		const legacy = client(old.kora, dir, 'legacy', port)
		const modern = client(v2.kora, dir, 'modern', port)
		await legacy.ready
		await modern.ready
		await legacy.sync.connect()
		await modern.sync.connect()
		const fromLegacy = await legacy.notes.insert({ title: 'from-beta12' })
		await until(
			async () => (await modern.notes.findById(fromLegacy.id))?.title === 'from-beta12',
			'legacy -> modern',
		)
		const fromModern = await modern.notes.insert({ title: 'from-v2' })
		await until(
			async () => (await legacy.notes.findById(fromModern.id))?.title === 'from-v2',
			'modern -> legacy',
		)
		await legacy.notes.update(fromModern.id, { title: 'legacy-edit' })
		await until(
			async () => (await modern.notes.findById(fromModern.id))?.title === 'legacy-edit',
			'legacy update -> modern',
		)
		const ops = store.getAllOperations()
		const legacyOp = ops.find((o) => o.recordId === fromLegacy.id)
		const modernOp = ops.find((o) => o.recordId === fromModern.id && o.type === 'insert')
		const rejectedLegacy = (await legacy.sync.getRejectedOperations?.()) ?? []
		await legacy.close()
		await modern.close()
		await server.stop()
		if (!warnings.includes('session.protocol_deprecated')) {
			throw new Error('no deprecation warning for the protocol-1 client')
		}
		if (rejectedLegacy.length > 0) throw new Error('legacy ops rejected')
		return {
			deprecationWarned: true,
			legacyOpHashVersion: legacyOp?.hashVersion ?? 1,
			modernOpHashVersion: modernOp?.hashVersion ?? 1,
		}
	}),
)

process.exit(results.every(Boolean) ? 0 : 1)
