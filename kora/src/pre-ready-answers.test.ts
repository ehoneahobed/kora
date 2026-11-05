import { defineSchema, t } from '@korajs/core'
import type { CollectionRecord, QueryBuilder, QueryDescriptor } from '@korajs/store'
import type { ReadAnswer, ReadQuery, ReadRecord, ReadResult } from '@korajs/sync/read'
import { describe, expect, it, vi } from 'vitest'
import { DeferredQueryBuilder, type DeferredQueryHost } from './deferred-query'
import {
	type AnswerSource,
	PreReadyAnswers,
	recordsFromAnswer,
	toReadQuery,
} from './pre-ready-answers'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), done: t.boolean().default(false) } },
		notes: { fields: { body: t.richtext() } },
	},
})

const wall = (wallTime: number) => ({ wallTime, logical: 0, nodeId: 'n' })

function record(id: string, values: Record<string, unknown>, created = 1, latest = 2): ReadRecord {
	return { id, values, fieldVersions: {}, created: wall(created), latest: wall(latest) }
}

function answer(records: ReadRecord[], status: ReadResult['status'] = 'ok'): ReadAnswer {
	return {
		frontier: 5,
		grantKey: 'g',
		result: {
			key: 'k',
			status,
			records,
			included: {},
			includedStatus: {},
			refreshed: [],
			absent: [],
		},
	}
}

const descriptor = (over: Partial<QueryDescriptor> = {}): QueryDescriptor => ({
	collection: 'todos',
	where: { done: false },
	orderBy: [{ field: 'title', direction: 'asc' }],
	...over,
})

/** A source the test settles by hand. */
function manualSource() {
	const asked: ReadQuery[] = []
	const settle: Array<{
		resolve(a: ReadAnswer): void
		reject(e: unknown): void
		signal?: AbortSignal
	}> = []
	const source: AnswerSource = {
		read: (query, options) => {
			asked.push(query)
			return new Promise<ReadAnswer>((resolve, reject) => {
				settle.push({ resolve, reject, ...(options?.signal ? { signal: options.signal } : {}) })
			})
		},
	}
	return { source, asked, settle }
}

describe('toReadQuery', () => {
	it('carries the query and keys it by its content', () => {
		const a = toReadQuery(descriptor({ limit: 5 }), schema)
		const b = toReadQuery(descriptor({ limit: 5 }), schema)
		const c = toReadQuery(descriptor({ limit: 6 }), schema)
		expect(a).toMatchObject({ collection: 'todos', where: { done: false }, limit: 5 })
		expect(a?.key).toBe(b?.key)
		expect(a?.key).not.toBe(c?.key)
	})

	it('refuses what memory cannot answer faithfully', () => {
		expect(toReadQuery(descriptor({ include: ['project'] }), schema)).toBeNull()
		expect(toReadQuery(descriptor({ collection: 'notes' }), schema)).toBeNull()
		expect(toReadQuery(descriptor({ collection: 'nope' }), schema)).toBeNull()
		expect(toReadQuery(descriptor({ where: { title: 'x'.repeat(300) } }), schema)).toBeNull()
	})
})

describe('recordsFromAnswer', () => {
	it('builds records in answer order, with null for fields the answer lacks', () => {
		const definition = schema.collections.todos
		if (!definition) throw new Error('fixture')
		const out = recordsFromAnswer(
			[record('b', { title: 'B', done: true }, 10, 20), record('a', { title: 'A' })],
			definition,
		)
		expect(out).toEqual([
			{ id: 'b', createdAt: 10, updatedAt: 20, title: 'B', done: true },
			{ id: 'a', createdAt: 1, updatedAt: 2, title: 'A', done: null },
		])
	})
})

describe('PreReadyAnswers', () => {
	it('delivers a complete answer once', async () => {
		const { source, settle } = manualSource()
		const deliver = vi.fn()
		new PreReadyAnswers({ source, schema }).subscribe(descriptor(), { deliver })
		settle[0]?.resolve(answer([record('a', { title: 'A', done: false })]))
		await Promise.resolve()
		await Promise.resolve()
		expect(deliver).toHaveBeenCalledTimes(1)
		expect(deliver.mock.calls[0]?.[0]).toHaveLength(1)
	})

	it.each(['partial', 'unsupported', 'denied'] as const)(
		'never delivers a %s answer',
		async (status) => {
			const { source, settle } = manualSource()
			const deliver = vi.fn()
			new PreReadyAnswers({ source, schema }).subscribe(descriptor(), { deliver })
			settle[0]?.resolve(answer([record('a', { title: 'A' })], status))
			await Promise.resolve()
			await Promise.resolve()
			expect(deliver).not.toHaveBeenCalled()
		},
	)

	it('swallows a failed read and aborts a withdrawn one', async () => {
		const { source, settle } = manualSource()
		const deliver = vi.fn()
		const answers = new PreReadyAnswers({ source, schema })
		answers.subscribe(descriptor(), { deliver })
		settle[0]?.reject(new Error('offline'))
		const withdraw = answers.subscribe(descriptor({ limit: 1 }), { deliver })
		withdraw?.()
		expect(settle[1]?.signal?.aborted).toBe(true)
		settle[1]?.resolve(answer([record('a', { title: 'A' })]))
		await Promise.resolve()
		await Promise.resolve()
		expect(deliver).not.toHaveBeenCalled()
	})

	it('returns null for a query it cannot answer', () => {
		const { source } = manualSource()
		expect(
			new PreReadyAnswers({ source, schema }).subscribe(descriptor({ include: ['x'] }), {
				deliver: vi.fn(),
			}),
		).toBeNull()
	})
})

describe('DeferredQueryBuilder with a pre-ready answer', () => {
	function setup() {
		let open = false
		let resolveReady: () => void = () => {}
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve
		})
		let storeCallback: ((rows: CollectionRecord[]) => void) | null = null
		const unsubscribeStore = vi.fn()
		const real = {
			subscribe: vi.fn((cb: (rows: CollectionRecord[]) => void) => {
				storeCallback = cb
				return unsubscribeStore
			}),
		}
		let deliverAnswer: ((rows: CollectionRecord[]) => void) | null = null
		const withdraw = vi.fn()
		const host: DeferredQueryHost = {
			whenReady: () => ready,
			resolve: () => (open ? (real as unknown as QueryBuilder<CollectionRecord>) : null),
			preReady: (_descriptor, deliver) => {
				deliverAnswer = deliver
				return withdraw
			},
		}
		return {
			host,
			openStore: async () => {
				open = true
				resolveReady()
				await ready
				await Promise.resolve()
			},
			answerWith: (rows: CollectionRecord[]) => deliverAnswer?.(rows),
			storeResult: (rows: CollectionRecord[]) => storeCallback?.(rows),
			withdraw,
			unsubscribeStore,
		}
	}
	const row = (id: string): CollectionRecord => ({ id, createdAt: 1, updatedAt: 1 })

	it('shows the answer before the store opens, then the store result replaces it', async () => {
		const s = setup()
		const seen: string[][] = []
		new DeferredQueryBuilder('todos', s.host).subscribe((rows) => seen.push(rows.map((r) => r.id)))
		s.answerWith([row('a')])
		await s.openStore()
		s.storeResult([row('a'), row('b')])
		expect(seen).toEqual([['a'], ['a', 'b']])
	})

	it('drops an answer that arrives after the store took over', async () => {
		const s = setup()
		const seen: string[][] = []
		new DeferredQueryBuilder('todos', s.host).subscribe((rows) => seen.push(rows.map((r) => r.id)))
		await s.openStore()
		s.answerWith([row('stale')])
		s.storeResult([row('fresh')])
		expect(seen).toEqual([['fresh']])
		expect(s.withdraw).toHaveBeenCalled()
	})

	it('delivers nothing after unsubscribing', () => {
		const s = setup()
		const seen: unknown[] = []
		const stop = new DeferredQueryBuilder('todos', s.host).subscribe((rows) => seen.push(rows))
		stop()
		s.answerWith([row('a')])
		expect(seen).toEqual([])
		expect(s.withdraw).toHaveBeenCalled()
	})
})
