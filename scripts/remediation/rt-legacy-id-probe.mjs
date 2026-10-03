#!/usr/bin/env node
/**
 * Red-team round 2 probe (RT-71): a real beta.13 (protocol 1) client writes ordinary
 * values through a v2 server that verifies every version-1 id.
 *
 * Usage: node scripts/remediation/rt-legacy-id-probe.mjs <path-to-beta13-build>
 * Prints one JSON line per case: whether the beta.13 client's write was refused.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(fileURLToPath(import.meta.url), '../../..')
const b13 = process.argv[2]
if (!b13) {
	console.error('usage: rt-legacy-id-probe.mjs <path-to-beta13-build>')
	process.exit(2)
}
const v2 = {
	kora: await import(join(here, 'kora/dist/index.js')),
	server: await import(join(here, 'packages/server/dist/index.js')),
}
const old = {
	kora: await import(join(b13, 'kora/dist/index.js')),
	core: await import(join(b13, 'packages/core/dist/index.js')),
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
		const out = {
			case: c.name,
			storedOnServer: stored.map((o) => o.type),
			rejected: rejected.map((r) => r.code),
			legacyRow: await legacy.notes.findById(row.id),
		}
		if (rejected.length > 0) failed = true
		console.log(JSON.stringify(out))
	} finally {
		await legacy.close()
		await server.stop()
		rmSync(dir, { recursive: true, force: true })
	}
}
process.exit(failed ? 1 : 0)
