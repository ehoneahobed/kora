/**
 * Packed instant-updates smoke: `store.instantUpdates` against the installed `korajs`,
 * `@korajs/store` and `@korajs/core` tarballs.
 *
 * Contract (docs/guide/instant-updates.md):
 *   - with the flag on, a subscriber's first callback carrying a new row runs BEFORE the
 *     write's transaction commits, and the commit keeps that row once (same id, no duplicate);
 *   - with the flag off (control), the same write is invisible until the commit;
 *   - `{ durable: true }` skips the prediction for that one write;
 *   - the prediction never diverged from the database: no `store:overlay-diverged` and no
 *     `store:overlay-disabled` event, at the Store and at `createApp`.
 *
 * The commit is held by a gate inside the adapter's transaction, so "before the commit" is a
 * state the script stands in; nothing waits on a timer.
 */
import { defineSchema, t } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { createApp } from 'korajs'
import { expect, expectEqual, pass, runScript } from './common.mjs'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})

const FAULT_EVENTS = ['store:overlay-diverged', 'store:overlay-disabled']

/** A minimal KoraEventEmitter that records every event. */
function recordingEmitter() {
	const listeners = new Map()
	const seen = []
	return {
		seen,
		on(type, listener) {
			const set = listeners.get(type) ?? new Set()
			set.add(listener)
			listeners.set(type, set)
			return () => set.delete(listener)
		},
		off(type, listener) {
			listeners.get(type)?.delete(listener)
		},
		emit(event) {
			seen.push(event)
			for (const listener of listeners.get(event.type) ?? []) listener(event)
		},
	}
}

/** better-sqlite3 whose write transactions wait before COMMIT until the script says so. */
class GatedAdapter extends BetterSqlite3Adapter {
	gating = false
	gates = []

	async transaction(fn) {
		if (!this.gating) return super.transaction(fn)
		let release = () => {}
		const wait = new Promise((resolve) => {
			release = resolve
		})
		this.gates.push({ release })
		return super.transaction(async (tx) => {
			await fn(tx)
			await wait
		})
	}
}

/** Event-loop turns (setImmediate, not timers) so queued notifications are delivered. */
async function turns(count = 6) {
	for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function heldCommit(instantUpdates) {
	const emitter = recordingEmitter()
	const adapter = new GatedAdapter(':memory:')
	const store = new Store({
		schema,
		adapter,
		nodeId: 'packed-instant-node',
		emitter,
		...(instantUpdates ? { instantUpdates: true } : {}),
	})
	await store.open()
	const todos = store.collection('todos')
	await todos.insert({ title: 'existing' })
	const deliveries = []
	const unsubscribe = todos.where({}).subscribe((rows) => {
		deliveries.push(rows.map((row) => String(row.title)).sort())
	})
	await turns()
	adapter.gating = true
	let committed = false
	const write = todos.insert({ title: 'added' }).then((record) => {
		committed = true
		return record
	})
	await turns()
	const state = {
		gateOpen: adapter.gates.length === 1,
		committedWhileHeld: committed,
		lastDelivery: deliveries.at(-1),
		overlay: store.getOverlayController() !== null,
	}
	adapter.gating = false
	for (const gate of adapter.gates) gate.release()
	const record = await write
	await turns()
	const rows = await todos.where({}).exec()
	unsubscribe()
	await store.close()
	return { state, record, rows, final: deliveries.at(-1), emitter }
}

await runScript('instant-updates-smoke', async () => {
	// Store, flag on: the row is shown while the transaction is open.
	const on = await heldCommit(true)
	expect(on.state.overlay, 'the packed store builds the instant-updates overlay')
	expect(on.state.gateOpen, 'the write transaction is open at its gate')
	expect(!on.state.committedWhileHeld, 'the write has not committed while the gate is held')
	expectEqual(
		on.state.lastDelivery,
		['added', 'existing'],
		'the first callback has the new row before the commit',
	)
	expectEqual(
		on.final,
		['added', 'existing'],
		'after the commit the subscriber still sees the row once',
	)
	expectEqual(
		on.rows.map((row) => row.id).filter((id) => id === on.record.id).length,
		1,
		'the committed row exists once',
	)
	for (const type of FAULT_EVENTS) {
		expect(!on.emitter.seen.some((event) => event.type === type), `no ${type} at the Store`)
	}
	pass('Store, flag on: first callback before commit; commit keeps the row once; no divergence')

	// Store, flag off: the control must NOT show the row early.
	const off = await heldCommit(false)
	expect(!off.state.overlay, 'flag off builds no overlay')
	expectEqual(
		off.state.lastDelivery,
		['existing'],
		'flag off: the row is invisible until the commit',
	)
	expectEqual(off.final, ['added', 'existing'], 'flag off: the commit makes the row visible')
	pass('Store, flag off (control): the row appears only at the commit')

	// createApp: the public entry users call.
	const app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: ':memory:', instantUpdates: true },
	})
	try {
		const timeline = []
		for (const type of ['store:write-pending', 'store:write-settled', ...FAULT_EVENTS]) {
			app.events.on(type, (event) => {
				timeline.push(
					event.type === 'store:write-settled' ? `settled:${event.outcome}` : event.type,
				)
			})
		}
		await app.ready
		app.todos.where({}).subscribe((rows) => {
			if (rows.some((row) => row.title === 'fast')) timeline.push('callback:fast')
		})
		await turns()
		await app.todos.insert({ title: 'fast' })
		timeline.push('write-resolved')
		await turns()
		const at = (label) => timeline.indexOf(label)
		expect(at('store:write-pending') >= 0, 'createApp registers the write as pending', timeline)
		expect(at('callback:fast') >= 0, 'createApp delivers the row to the subscriber', timeline)
		expect(
			at('callback:fast') < at('settled:committed'),
			'createApp: the callback runs before the write settles as committed',
			timeline,
		)
		expect(
			at('settled:committed') < at('write-resolved'),
			'the promise resolves after the commit',
			timeline,
		)
		for (const type of FAULT_EVENTS) {
			expect(!timeline.includes(type), `no ${type} through createApp`, timeline)
		}
		await app.todos.insert({ title: 'waits' }, { durable: true })
		const pending = []
		app.events.on('store:write-pending', (event) => pending.push(event.predicted))
		await app.todos.insert({ title: 'durable', completed: true }, { durable: true })
		await app.todos.insert({ title: 'predicted' })
		expectEqual(
			pending,
			[false, true],
			'{ durable: true } skips the prediction for that write only',
		)
		pass('createApp: callback before commit, promise after, durable opt-out, no divergence')
	} finally {
		await app.close()
	}
})
