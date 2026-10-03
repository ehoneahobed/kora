#!/usr/bin/env node
/**
 * Red-team round 3 probe (RT-83): a beta.12 (or older) device that cleared fields with
 * `undefined` upgrades to beta.13 on the same database.
 *
 * beta.12 applied `update(id, { assignee: undefined })` to the row (NULL), but its op
 * log is JSON, so the logged operation has no `assignee`. beta.13's one-time fold
 * materialization rebuilds rows from the log. Two phases per case:
 *
 * 1. local: the row before and after the upgrade (no sync);
 * 2. sync (round 4): the beta.12 device writes through a beta.13 server (protocol 1),
 *    upgrades on the same database, reconnects as beta.13; a fresh beta.13 peer joins.
 *    The upgraded device, the peer and the server must hold one row.
 *
 * Prints one JSON line per case and phase; exit 1 when anything differs.
 *
 * Run it against the last published release, 1.0.0-beta.12 (tag v1.0.0-beta.12;
 * compat-beta12.mjs says how to build it).
 *
 * Usage: node scripts/remediation/rt3-upgrade-clear-probe.mjs <path-to-beta12-build>
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(fileURLToPath(import.meta.url), '../../..')
const b12 = process.argv[2]
if (!b12) {
	console.error('usage: rt3-upgrade-clear-probe.mjs <path-to-beta12-build>')
	process.exit(2)
}
const v2 = await import(join(here, 'kora/dist/index.js'))
const v2server = await import(join(here, 'packages/server/dist/index.js'))
const old = await import(join(b12, 'kora/dist/index.js'))
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
				},
			},
		},
	})
}

const cases = [
	{ name: 'top-level undefined with another field', update: { assignee: undefined, title: 'y' } },
	{ name: 'only undefined', update: { assignee: undefined } },
	{ name: 'nested member undefined', update: { meta: { a: 2, b: undefined } } },
]
const pick = (r) =>
	r ? { title: r.title, assignee: r.assignee ?? null, meta: r.meta ?? null } : null
let failed = false

for (const c of cases) {
	const dir = mkdtempSync(join(tmpdir(), 'kora-rt83-'))
	const name = join(dir, 'app.db')
	try {
		const legacy = old.createApp({
			schema: schemaOf(old),
			store: { adapter: 'better-sqlite3', name },
		})
		await legacy.ready
		const row = await legacy.notes.insert({ title: 'x', assignee: 'bob', meta: { a: 1, b: 'q' } })
		await legacy.notes.update(row.id, c.update)
		const before = await legacy.notes.findById(row.id)
		await legacy.close()

		const upgraded = v2.createApp({
			schema: schemaOf(v2),
			store: { adapter: 'better-sqlite3', name },
		})
		await upgraded.ready
		const after = await upgraded.notes.findById(row.id)
		await upgraded.close()
		const same = JSON.stringify(pick(before)) === JSON.stringify(pick(after))
		if (!same) failed = true
		console.log(
			JSON.stringify({
				case: c.name,
				phase: 'local',
				same,
				before: pick(before),
				after: pick(after),
			}),
		)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

async function waitForRow(app, id) {
	let found = null
	for (let i = 0; i < 40 && found === null; i++) {
		await sleep(100)
		found = await app.notes.findById(id)
	}
	await sleep(500)
	return app.notes.findById(id)
}

for (const c of cases) {
	for (const writes of ['synced', 'offline']) {
		const dir = mkdtempSync(join(tmpdir(), 'kora-rt83-sync-'))
		const name = join(dir, 'app.db')
		const port = 48600 + Math.floor(Math.random() * 300)
		const store = new v2server.MemoryServerStore()
		await store.setSchema(schemaOf(v2))
		const server = v2server.createKoraServer({ store, port })
		await server.start()
		const url = `ws://127.0.0.1:${port}`
		const apps = []
		try {
			// beta.12 writes: either synced as it goes (protocol 1), or offline (the upgraded
			// device uploads its beta.12 log).
			const legacy = old.createApp({
				schema: schemaOf(old),
				store: { adapter: 'better-sqlite3', name },
				...(writes === 'synced' ? { sync: { url } } : {}),
			})
			await legacy.ready
			if (writes === 'synced') await legacy.sync.connect()
			const row = await legacy.notes.insert({ title: 'x', assignee: 'bob', meta: { a: 1, b: 'q' } })
			await sleep(300)
			await legacy.notes.update(row.id, c.update)
			await sleep(writes === 'synced' ? 1500 : 100)
			const before = await legacy.notes.findById(row.id)
			await legacy.close()

			const upgraded = v2.createApp({
				schema: schemaOf(v2),
				store: { adapter: 'better-sqlite3', name },
				sync: { url },
			})
			apps.push(upgraded)
			await upgraded.ready
			await upgraded.sync.connect()
			const peer = v2.createApp({
				schema: schemaOf(v2),
				store: { adapter: 'better-sqlite3', name: join(dir, 'peer.db') },
				sync: { url },
			})
			apps.push(peer)
			await peer.ready
			await peer.sync.connect()
			const peerRow = await waitForRow(peer, row.id)
			await sleep(500)
			const upgradedRow = await upgraded.notes.findById(row.id)
			const serverRow = await store.findRecord('notes', row.id)
			const rejected = [
				...((await upgraded.sync.getRejectedOperations?.()) ?? []),
				...((await peer.sync.getRejectedOperations?.()) ?? []),
			].map((r) => r.code)
			const quarantined = (await peer.sync.getQuarantinedOperations?.()) ?? []
			const rows = [before, upgradedRow, peerRow, serverRow].map((r) => JSON.stringify(pick(r)))
			const converged = rows.every((r) => r === rows[0])
			if (!converged || rejected.length > 0 || quarantined.length > 0) failed = true
			console.log(
				JSON.stringify({
					case: c.name,
					phase: `sync (${writes})`,
					converged,
					rejected,
					quarantined: quarantined.length,
					beta12: pick(before),
					...(converged
						? {}
						: { upgraded: pick(upgradedRow), peer: pick(peerRow), server: pick(serverRow) }),
				}),
			)
		} finally {
			for (const app of apps.splice(0)) await app.close()
			await server.stop()
			rmSync(dir, { recursive: true, force: true })
		}
	}
}
process.exit(failed ? 1 : 0)
