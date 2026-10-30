import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { SharedDatabaseFile } from '../../tests/fixtures/browser-sim'
import { SqliteWasmAdapter } from '../adapters/sqlite-wasm-adapter'
import type { WorkerBridge, WorkerRequest, WorkerResponse } from '../adapters/sqlite-wasm-channel'
import { Store } from '../store/store'
import { quiesce } from './test-support'

/*
 * Instant-UI S5: the crash tests (design 7, "tab killed or navigated away", and 12.5).
 *
 * The overlay lives in the tab and dies with it, so the property is on the DATABASE: after a
 * tab is killed at any point inside a write, a fresh tab that reopens the same database finds
 * the row if (and only if) the COMMIT had landed, never a phantom row, and nothing the dead
 * write reserved (a sequence number, an operation) is left behind.
 *
 * A "kill" here is what the browser does to a dedicated worker: the worker stops answering
 * and the SQLite connection rolls back whatever transaction was open. The "database file"
 * is the SharedDatabaseFile of the multi-tab fixtures, which outlives the worker the way an
 * OPFS file does. Every wait is a promise the test resolves or a count of event-loop turns:
 * no timers.
 */

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), done: t.boolean().default(false) } },
	},
})

const NODE = 'crash-node'

/** A worker a test can hold requests of and kill. */
class KillableWorker implements WorkerBridge {
	killed = false
	/** Awaited before each request reaches the database (hold a request by returning a promise). */
	hold: ((request: WorkerRequest) => Promise<void> | undefined) | null = null
	private openSpan = false

	constructor(private readonly file: SharedDatabaseFile) {}

	async send(request: WorkerRequest): Promise<WorkerResponse> {
		if (this.killed) return this.dead(request)
		await this.hold?.(request)
		// Killed while the request was held: it never reached the database.
		if (this.killed) return this.dead(request)
		if (request.type === 'begin') this.openSpan = true
		if (request.type === 'commit' || request.type === 'rollback') this.openSpan = false
		return this.file.send(request)
	}

	/** The tab dies: the connection rolls back its open transaction and answers nothing more. */
	kill(): void {
		this.killed = true
		if (this.openSpan) {
			this.openSpan = false
			void this.file.send({ id: 0, type: 'rollback' })
		}
	}

	terminate(): void {}

	private dead(request: WorkerRequest): WorkerResponse {
		return { id: request.id, type: 'error', message: 'tab killed', code: 'WORKER_TERMINATED' }
	}
}

interface Tab {
	readonly store: Store
	readonly worker: KillableWorker
	readonly adapter: SqliteWasmAdapter
}

async function openTab(file: SharedDatabaseFile, instantUpdates: boolean): Promise<Tab> {
	const worker = new KillableWorker(file)
	const adapter = new SqliteWasmAdapter({ bridge: worker, dbName: 'crash-db' })
	const store = new Store({
		schema,
		adapter,
		dbName: 'crash-db',
		nodeId: NODE,
		...(instantUpdates ? { instantUpdates: true } : {}),
	})
	await store.open()
	return { store, worker, adapter }
}

/** What the database holds, read straight from the file (no store, no overlay). */
async function durableState(
	file: SharedDatabaseFile,
): Promise<{ titles: string[]; sequences: number[] }> {
	const read = async (sql: string): Promise<Array<Record<string, unknown>>> => {
		const response = await file.send({ id: 0, type: 'query', sql })
		if (response.type !== 'success') throw new Error(response.message)
		return response.data as Array<Record<string, unknown>>
	}
	const rows = await read('SELECT title FROM todos ORDER BY title')
	const ops = await read('SELECT sequence_number FROM _kora_ops_todos ORDER BY sequence_number')
	return {
		titles: rows.map((row) => String(row.title)),
		sequences: ops.map((row) => Number(row.sequence_number)),
	}
}

/** A promise and the function that resolves it. */
function latch(): { promise: Promise<void>; open: () => void } {
	let open: () => void = () => {}
	const promise = new Promise<void>((resolve) => {
		open = resolve
	})
	return { promise, open }
}

function watchTitles(tab: Tab): { latest: () => string[] } {
	let latest: string[] = []
	tab.store
		.collection('todos')
		.where({})
		.orderBy('title', 'asc')
		.subscribe(
			(rows) => {
				latest = rows.map((row) => String(row.title))
			},
			// The settle read of a killed tab fails by design; the test is not about that error.
			{ onError: () => {} },
		)
	return { latest: () => latest }
}

describe('a tab killed inside a write (instant updates on)', () => {
	test('killed while the COMMIT is held: the row was shown, is absent after reopen, and leaves nothing behind', async () => {
		const file = new SharedDatabaseFile()
		const tab = await openTab(file, true)
		await tab.store.collection('todos').insert({ title: 'seed' })
		const view = watchTitles(tab)
		await quiesce()
		expect(view.latest()).toEqual(['seed'])

		const commitReached = latch()
		const commitGate = latch()
		tab.worker.hold = (request) => {
			if (request.type !== 'commit') return undefined
			commitReached.open()
			return commitGate.promise
		}
		const write = tab.store.collection('todos').insert({ title: 'phantom?' })
		const outcome = write.then(
			() => 'resolved',
			() => 'rejected',
		)
		await commitReached.promise

		// Before the kill the user sees the row (that is the feature) but the promise is pending
		// and nothing was saved: this is the window the design discloses.
		expect(view.latest()).toEqual(['phantom?', 'seed'])
		expect(tab.store.getOverlayController()?.pending).toBe(1)

		tab.worker.kill()
		commitGate.open()
		expect(await outcome).toBe('rejected')

		// A fresh tab on the same database: only what was committed.
		expect(await durableState(file)).toEqual({ titles: ['seed'], sequences: [1] })
		const reopened = await openTab(file, true)
		const after = watchTitles(reopened)
		await quiesce()
		expect(after.latest()).toEqual(['seed'])
		expect(reopened.store.getOverlayController()?.pending).toBe(0)

		// The sequence the dead write had reserved inside its rolled-back transaction was not
		// consumed: the next write continues the log without a gap.
		await reopened.store.collection('todos').insert({ title: 'after' })
		expect(await durableState(file)).toEqual({ titles: ['after', 'seed'], sequences: [1, 2] })
		await reopened.store.close()
	})

	test('killed before BEGIN reaches the database: the row was shown, is absent after reopen', async () => {
		const file = new SharedDatabaseFile()
		const tab = await openTab(file, true)
		const view = watchTitles(tab)
		await quiesce()

		const beginReached = latch()
		const beginGate = latch()
		tab.worker.hold = (request) => {
			if (request.type !== 'begin') return undefined
			beginReached.open()
			return beginGate.promise
		}
		const write = tab.store.collection('todos').insert({ title: 'never started' })
		const outcome = write.then(
			() => 'resolved',
			() => 'rejected',
		)
		await beginReached.promise
		expect(view.latest()).toEqual(['never started'])

		tab.worker.kill()
		beginGate.open()
		expect(await outcome).toBe('rejected')

		expect(await durableState(file)).toEqual({ titles: [], sequences: [] })
		const reopened = await openTab(file, true)
		expect(await reopened.store.collection('todos').where({}).exec()).toEqual([])
		await reopened.store.close()
	})

	test('killed after the COMMIT landed but before the SQL settle: the row survives, exactly once', async () => {
		const file = new SharedDatabaseFile()
		const tab = await openTab(file, true)
		await tab.store.collection('todos').insert({ title: 'seed' })
		const view = watchTitles(tab)
		await quiesce()

		// Hold the first read of todos after the commit: the settle re-run of the live query.
		let committed = false
		const settleReached = latch()
		const settleGate = latch()
		tab.worker.hold = (request) => {
			if (request.type === 'commit') {
				committed = true
				return undefined
			}
			if (
				committed &&
				request.type === 'query' &&
				/FROM\s+"?todos"?/i.test(request.sql) &&
				!request.sql.includes('_kora_')
			) {
				settleReached.open()
				return settleGate.promise
			}
			return undefined
		}
		await tab.store.collection('todos').insert({ title: 'landed' })
		await settleReached.promise

		// The promise resolved (the write is durable on OPFS), the screen already showed the row,
		// and the tab dies with the settle read still in flight.
		expect(view.latest()).toEqual(['landed', 'seed'])
		tab.worker.kill()
		settleGate.open()

		expect(await durableState(file)).toEqual({ titles: ['landed', 'seed'], sequences: [1, 2] })
		const reopened = await openTab(file, true)
		const after = watchTitles(reopened)
		await quiesce()
		expect(after.latest()).toEqual(['landed', 'seed'])
		await reopened.store.close()
	})

	test('the same kill with the flag off leaves the same durable state (the overlay changes nothing stored)', async () => {
		const run = async (instantUpdates: boolean) => {
			const file = new SharedDatabaseFile()
			const tab = await openTab(file, instantUpdates)
			await tab.store.collection('todos').insert({ title: 'seed' })
			const commitReached = latch()
			const commitGate = latch()
			tab.worker.hold = (request) => {
				if (request.type !== 'commit') return undefined
				commitReached.open()
				return commitGate.promise
			}
			const write = tab.store.collection('todos').insert({ title: 'in flight' })
			write.catch(() => {})
			await commitReached.promise
			tab.worker.kill()
			commitGate.open()
			await write.then(
				() => undefined,
				() => undefined,
			)
			return durableState(file)
		}
		expect(await run(true)).toEqual(await run(false))
	})
})
