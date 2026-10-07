#!/usr/bin/env node
/**
 * One measurement of the store's gated workloads, against the BUILT packages of a
 * checkout: `node scripts/bench/store-workload.mjs <checkout-root>`.
 *
 * Prints one JSON line: { insertMs, queryMs }. insertMs is the time to insert 10,000
 * records in one transaction (the "< 2 s" gate), queryMs the time of a WHERE query
 * returning 1,000 of them (the "< 50 ms" gate). One warm-up pass runs first, so the
 * measured pass is not dominated by JIT compilation. Used by ab-regression.mjs, which
 * runs it alternately against two checkouts on the same machine.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? '.')
const load = (path) => import(pathToFileURL(resolve(root, path)).href)
const { defineSchema, t } = await load('packages/core/dist/index.js')
const { Store } = await load('packages/store/dist/index.js')
const { BetterSqlite3Adapter } = await load('packages/store/dist/adapters/better-sqlite3.js')

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})

async function pass() {
	const store = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(':memory:'),
		nodeId: 'bench-node',
	})
	await store.open()
	const started = performance.now()
	await store.transaction(async (tx) => {
		const todos = tx.collection('todos')
		for (let index = 0; index < 10_000; index++) {
			await todos.insert({ title: `todo-${index}`, completed: index % 10 === 0 })
		}
	})
	const insertMs = performance.now() - started
	const queryStarted = performance.now()
	const rows = await store.collection('todos').where({ completed: true }).exec()
	const queryMs = performance.now() - queryStarted
	if (rows.length !== 1000) throw new Error(`expected 1000 rows, got ${rows.length}`)
	await store.close()
	return { insertMs, queryMs }
}

await pass()
console.log(JSON.stringify(await pass()))
