import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import {
	PHASE_NAMES,
	PhaseTimers,
	activePhaseTimers,
	installPhaseTimers,
	summarizePhases,
	summarizeSamples,
} from './phase-timers'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('phase timers (S0, internal)', () => {
	let store: Store | null = null

	afterEach(async () => {
		installPhaseTimers(null)
		await store?.close()
		store = null
	})

	async function open(): Promise<Store> {
		const s = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'phase-node',
		})
		await s.open()
		store = s
		return s
	}

	async function waitFor(timers: PhaseTimers, rereads: number): Promise<void> {
		for (let i = 0; i < 200; i++) {
			const open = timers.peek()
			if (open && open.callbacks > 0 && open.rereads >= rereads) break
			await nextTask()
		}
		await nextTask()
	}

	test('nothing is installed by default', () => {
		expect(activePhaseTimers()).toBeNull()
	})

	test('records every phase of insert, update and delete with an active subscription', async () => {
		const s = await open()
		const todos = s.collection('todos')
		const seeded = await todos.insert({ title: 'seed', completed: true })
		const other = await todos.insert({ title: 'other', completed: true })
		let calls = 0
		s.collection('todos')
			.where({ completed: true })
			.subscribe(() => {
				calls++
			})
		while (calls === 0) await nextTask()

		const timers = new PhaseTimers()
		installPhaseTimers(timers)
		await todos.insert({ title: 'a', completed: true })
		await waitFor(timers, 1)
		await todos.update(seeded.id, { title: 'edited' })
		await waitFor(timers, 1)
		await todos.delete(other.id)
		await waitFor(timers, 1)
		installPhaseTimers(null)

		const records = timers.take()
		expect(records.map((record) => record.kind)).toEqual(['insert', 'update', 'delete'])
		for (const record of records) {
			expect(record.rereads).toBe(1)
			expect(record.callbacks).toBe(1)
			expect(record.publishedAt).not.toBeNull()
			expect(record.firstCallbackAt ?? 0).toBeGreaterThanOrEqual(record.publishedAt ?? 0)
			for (const name of PHASE_NAMES) {
				expect(record.phases[name]).toBeGreaterThanOrEqual(0)
			}
			// The write body and the re-read both did real work.
			expect(record.phases.body).toBeGreaterThan(0)
			expect(record.phases.reread).toBeGreaterThan(0)
			expect(record.phases.sequence).toBeLessThanOrEqual(record.phases.body)
		}
	})

	test('does not change write or subscription results', async () => {
		const s = await open()
		const seen: number[] = []
		s.collection('todos')
			.where({})
			.subscribe((rows) => {
				seen.push(rows.length)
			})
		await nextTask()
		installPhaseTimers(new PhaseTimers())
		await s.collection('todos').insert({ title: 'x' })
		await nextTask()
		await nextTask()
		installPhaseTimers(null)
		await s.collection('todos').insert({ title: 'y' })
		await nextTask()
		await nextTask()
		expect(seen.at(-1)).toBe(2)
	})

	test('summaries use nearest-rank percentiles', () => {
		expect(summarizeSamples([])).toEqual({ p50: 0, p95: 0 })
		expect(summarizeSamples([5, 1, 3, 2, 4])).toEqual({ p50: 3, p95: 4 })
		const timers = new PhaseTimers()
		timers.begin('insert')
		timers.add('commit', 7)
		const summary = summarizePhases(timers.take())
		expect(summary.commit.p50).toBe(7)
		expect(summary.reread.p50).toBe(0)
	})
})
