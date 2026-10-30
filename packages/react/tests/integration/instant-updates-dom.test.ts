import { defineSchema, t } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { KoraProvider } from '../../src/context/kora-context'
import { useQuery } from '../../src/hooks/use-query'

/*
 * Instant-UI S5, design 12.5: the React side of the gate. With `instantUpdates` on, a row
 * written through a real Store is in the DOM that @korajs/react renders BEFORE the write's
 * COMMIT, and the committed row replaces the predicted one without a duplicate or a flash.
 *
 * The commit is held by the test (a gate inside the adapter's transaction), so "before the
 * commit" is a state the test stands in; nothing here waits for time. The 16 ms budget
 * itself is measured in a real browser on OPFS (packages/store/benchmarks/browser,
 * `reactDom`): jsdom's clock says nothing about a frame.
 */

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})

/** better-sqlite3 whose write transactions wait before COMMIT until the test says so. */
class GatedAdapter extends BetterSqlite3Adapter {
	gating = false
	readonly gates: Array<{ release(): void; fail(): void }> = []

	override async transaction(
		fn: Parameters<BetterSqlite3Adapter['transaction']>[0],
	): Promise<void> {
		if (!this.gating) return super.transaction(fn)
		let release: () => void = () => {}
		let reject: (error: Error) => void = () => {}
		const wait = new Promise<void>((resolve, rejectWith) => {
			release = resolve
			reject = rejectWith
		})
		wait.catch(() => {})
		this.gates.push({ release, fail: () => reject(new Error('injected: commit failed')) })
		return super.transaction(async (tx) => {
			await fn(tx)
			await wait
		})
	}
}

/** Event-loop turns inside act, so React commits what the store published (no timers). */
async function turns(count = 6): Promise<void> {
	for (let i = 0; i < count; i++) {
		await act(async () => {
			await new Promise<void>((resolve) => setImmediate(resolve))
		})
	}
}

async function openStore(
	instantUpdates: boolean,
): Promise<{ store: Store; adapter: GatedAdapter }> {
	const adapter = new GatedAdapter(':memory:')
	const store = new Store({
		schema,
		adapter,
		nodeId: 'react-dom-node',
		...(instantUpdates ? { instantUpdates: true } : {}),
	})
	await store.open()
	return { store, adapter }
}

function mountList(store: Store): { rows: () => string[] } {
	function List() {
		const todos = useQuery(store.collection('todos').where({ completed: false }))
		return createElement(
			'ul',
			null,
			todos.map((todo) =>
				createElement('li', { key: todo.id, 'data-id': todo.id }, String(todo.title)),
			),
		)
	}
	const view = render(createElement(KoraProvider, { store }, createElement(List)))
	return {
		rows: () => Array.from(view.container.querySelectorAll('li')).map((li) => li.textContent ?? ''),
	}
}

afterEach(() => {
	cleanup()
})

describe('useQuery with instant updates (real store, commit held)', () => {
	it('on: the new row is in the DOM before the COMMIT; the commit keeps it, once', async () => {
		const { store, adapter } = await openStore(true)
		try {
			await store.collection('todos').insert({ title: 'existing' })
			const view = mountList(store)
			await turns()
			expect(view.rows()).toEqual(['existing'])

			adapter.gating = true
			let write: Promise<unknown> = Promise.resolve()
			await act(async () => {
				write = store.collection('todos').insert({ title: 'added' })
			})
			await turns()
			// The transaction is open and waiting at its gate: nothing is committed, the DOM has it.
			expect(adapter.gates).toHaveLength(1)
			expect(view.rows()).toEqual(['existing', 'added'])
			const idBefore = document.querySelectorAll('li')[1]?.getAttribute('data-id')

			adapter.gates[0]?.release()
			await act(async () => {
				await write
			})
			await turns()
			expect(view.rows()).toEqual(['existing', 'added'])
			// Same record id before and after: React keeps the node (no remount, no flash).
			expect(document.querySelectorAll('li')[1]?.getAttribute('data-id')).toBe(idBefore)
			expect(await store.collection('todos').where({}).count()).toBe(2)
		} finally {
			await store.close()
		}
	})

	it('off (control): the row is not in the DOM until the commit', async () => {
		const { store, adapter } = await openStore(false)
		try {
			await store.collection('todos').insert({ title: 'existing' })
			const view = mountList(store)
			await turns()

			adapter.gating = true
			let write: Promise<unknown> = Promise.resolve()
			await act(async () => {
				write = store.collection('todos').insert({ title: 'added' })
			})
			await turns()
			expect(adapter.gates).toHaveLength(1)
			expect(view.rows()).toEqual(['existing'])

			adapter.gates[0]?.release()
			await act(async () => {
				await write
			})
			await turns()
			expect(view.rows()).toEqual(['existing', 'added'])
		} finally {
			await store.close()
		}
	})

	it('on: a write that fails at COMMIT is taken out of the DOM again', async () => {
		const { store, adapter } = await openStore(true)
		try {
			const view = mountList(store)
			await turns()
			adapter.gating = true
			let outcome: Promise<string> = Promise.resolve('')
			await act(async () => {
				outcome = store
					.collection('todos')
					.insert({ title: 'doomed' })
					.then(
						() => 'resolved',
						() => 'rejected',
					)
			})
			await turns()
			expect(view.rows()).toEqual(['doomed'])

			adapter.gates[0]?.fail()
			await act(async () => {
				expect(await outcome).toBe('rejected')
			})
			await turns()
			expect(view.rows()).toEqual([])
		} finally {
			await store.close()
		}
	})

	it('on: an update and a delete are reflected before their commits too', async () => {
		const { store, adapter } = await openStore(true)
		try {
			const first = await store.collection('todos').insert({ title: 'first' })
			await store.collection('todos').insert({ title: 'second' })
			const view = mountList(store)
			await turns()
			expect(view.rows()).toEqual(['first', 'second'])

			adapter.gating = true
			let edit: Promise<unknown> = Promise.resolve()
			await act(async () => {
				edit = store.collection('todos').update(first.id, { completed: true })
			})
			await turns()
			// The update moved the record out of `completed = false`: gone before its commit.
			expect(view.rows()).toEqual(['second'])

			adapter.gates[0]?.release()
			await act(async () => {
				await edit
			})
			await turns()
			expect(view.rows()).toEqual(['second'])

			const second = (await store.collection('todos').where({}).exec()).find(
				(todo) => todo.title === 'second',
			)
			expect(second).toBeDefined()
			let removal: Promise<unknown> = Promise.resolve()
			await act(async () => {
				removal = store.collection('todos').delete(second?.id ?? '')
			})
			await turns()
			expect(adapter.gates).toHaveLength(2)
			expect(view.rows()).toEqual([])

			adapter.gates[1]?.release()
			await act(async () => {
				await removal
			})
			await turns()
			expect(view.rows()).toEqual([])
		} finally {
			await store.close()
		}
	})
})
