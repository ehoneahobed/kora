#!/usr/bin/env node
/**
 * Red-team round 3 probe (RT-83): a beta.13 device that cleared fields with
 * `undefined` upgrades to beta.14 on the same database.
 *
 * beta.13 applied `update(id, { assignee: undefined })` to the row (NULL), but its op
 * log is JSON, so the logged operation has no `assignee`. beta.14's one-time fold
 * materialization rebuilds rows from the log. Prints the row before and after the
 * upgrade; exit 1 when they differ.
 *
 * Usage: node scripts/remediation/rt3-upgrade-clear-probe.mjs <path-to-beta13-build>
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(fileURLToPath(import.meta.url), '../../..')
const b13 = process.argv[2]
if (!b13) {
	console.error('usage: rt3-upgrade-clear-probe.mjs <path-to-beta13-build>')
	process.exit(2)
}
const v2 = await import(join(here, 'kora/dist/index.js'))
const old = await import(join(b13, 'kora/dist/index.js'))

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
		const pick = (r) => r && { title: r.title, assignee: r.assignee ?? null, meta: r.meta ?? null }
		const same = JSON.stringify(pick(before)) === JSON.stringify(pick(after))
		if (!same) failed = true
		console.log(JSON.stringify({ case: c.name, same, before: pick(before), after: pick(after) }))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}
process.exit(failed ? 1 : 0)
