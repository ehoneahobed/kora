#!/usr/bin/env node
/**
 * Red-team round 2 probe (RT-71): a real beta.12 (protocol 1) client writes ordinary
 * values through a v2 server that verifies every version-1 id.
 *
 * Run it against the last published release, 1.0.0-beta.12 (tag v1.0.0-beta.12;
 * compat-beta12.mjs says how to build it).
 *
 * Usage: node scripts/remediation/rt-legacy-id-probe.mjs <path-to-beta12-build>
 * Prints one JSON line per case: whether the beta.12 client's write was refused, how
 * the server stored it (`hashVersion` 1 = verified, absent = stored unverified, RT-71),
 * and whether a beta.13 peer converged to the beta.12 client's row.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(fileURLToPath(import.meta.url), '../../..')
const b12 = process.argv[2]
if (!b12) {
	console.error('usage: rt-legacy-id-probe.mjs <path-to-beta12-build>')
	process.exit(2)
}
const v2 = {
	kora: await import(join(here, 'kora/dist/index.js')),
	server: await import(join(here, 'packages/server/dist/index.js')),
}
const old = {
	kora: await import(join(b12, 'kora/dist/index.js')),
	core: await import(join(b12, 'packages/core/dist/index.js')),
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function schemaOf(kora) {
	const { t } = kora
	return kora.defineSchema({
		version: 1,
		collections: {
			notes: {
				fields: {
					title: t.string(),
					assignee: t.string().optional(),
					meta: t.object({ a: t.number().optional(), b: t.string().optional() }).optional(),
					n: t.number().default(0),
					tags: t.array(t.string()).default([]),
					extra: t.json().optional(),
					due: t.timestamp().optional(),
				},
			},
		},
	})
}

const cases = [
	{ name: 'insert plain', insert: { title: 'x' } },
	{ name: 'insert nested object undefined', insert: { title: 'x', meta: { a: 1, b: undefined } } },
	{
		name: 'update top-level undefined',
		insert: { title: 'x', assignee: 'bob' },
		update: { assignee: undefined, title: 'y' },
	},
	{
		name: 'update nested undefined',
		insert: { title: 'x' },
		update: { meta: { a: 2, b: undefined } },
	},
	{
		name: 'increment',
		insert: { title: 'x', n: 1 },
		update: () => ({ n: old.core.op.increment(2) }),
	},
	{
		name: 'numbers, unicode, key order, timestamp',
		insert: {
			title: 'é\u{1F600} ',
			n: 1e21,
			extra: { z: [1, { b: 2, a: 0.1 + 0.2 }], a: -0, m: 5e-324 },
			due: Date.now(),
			tags: ['b', 'a', 'a'],
		},
		update: { n: -0, tags: ['x'], extra: { q: null } },
	},
]

let failed = false
const peers = []
/** The user-visible fields of a row (timestamps the store sets are per device). */
function content(row) {
	if (row === null || row === undefined) return null
	const { createdAt: _c, updatedAt: _u, ...rest } = row
	return rest
}
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.filter((k) => value[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}
for (const c of cases) {
	const dir = mkdtempSync(join(tmpdir(), 'kora-rt71-'))
	const port = 48100 + Math.floor(Math.random() * 400)
	const store = new v2.server.MemoryServerStore()
	await store.setSchema(schemaOf(v2.kora))
	const server = v2.server.createKoraServer({ store, port })
	await server.start()
	const legacy = old.kora.createApp({
		schema: schemaOf(old.kora),
		store: { adapter: 'better-sqlite3', name: join(dir, 'legacy.db') },
		sync: { url: `ws://127.0.0.1:${port}` },
	})
	try {
		await legacy.ready
		await legacy.sync.connect()
		const row = await legacy.notes.insert(c.insert)
		if (c.update) {
			await sleep(500)
			await legacy.notes.update(row.id, typeof c.update === 'function' ? c.update() : c.update)
		}
		await sleep(1500)
		const rejected = (await legacy.sync.getRejectedOperations?.()) ?? []
		const stored = store.getAllOperations().filter((o) => o.recordId === row.id)
		const peer = v2.kora.createApp({
			schema: schemaOf(v2.kora),
			store: { adapter: 'better-sqlite3', name: join(dir, 'peer.db') },
			sync: { url: `ws://127.0.0.1:${port}` },
		})
		peers.push(peer)
		await peer.ready
		await peer.sync.connect()
		let peerRow = null
		for (let i = 0; i < 40 && peerRow === null; i++) {
			await sleep(100)
			peerRow = await peer.notes.findById(row.id)
		}
		await sleep(500)
		peerRow = await peer.notes.findById(row.id)
		const legacyRow = await legacy.notes.findById(row.id)
		const converged = canonical(content(legacyRow)) === canonical(content(peerRow))
		const peerRejected = (await peer.sync.getRejectedOperations?.()) ?? []
		const peerQuarantined = (await peer.sync.getQuarantinedOperations?.()) ?? []
		const out = {
			case: c.name,
			storedOnServer: stored.map((o) => `${o.type}:v${o.hashVersion ?? '-'}`),
			rejected: rejected.map((r) => r.code),
			converged,
			peerRejected: peerRejected.length,
			peerQuarantined: peerQuarantined.length,
			legacyRow,
			...(converged ? {} : { peerRow }),
		}
		if (rejected.length > 0 || !converged || peerQuarantined.length > 0) failed = true
		console.log(JSON.stringify(out))
	} finally {
		for (const peer of peers.splice(0)) await peer.close()
		await legacy.close()
		await server.stop()
		rmSync(dir, { recursive: true, force: true })
	}
}
process.exit(failed ? 1 : 0)
