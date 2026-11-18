import type { CollectionRecord, QueryBuilder } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import { cleanup, render } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import KoraQueryProbe from '../../tests/fixtures/KoraQueryProbe.svelte'

const context = vi.hoisted(() => ({ cache: null as unknown }))
vi.mock('../context', () => ({
	getKoraContext: () => ({
		store: {},
		syncEngine: null,
		app: null,
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache: context.cache,
	}),
}))

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

/** A query whose rows and failures the test drives; `answer: false` keeps it pending. */
function fakeQuery(key: string, rows: CollectionRecord[], answer = true) {
	let emit: ((rows: CollectionRecord[]) => void) | null = null
	let fail: ((error: Error) => void) | null = null
	return {
		query: {
			getDescriptor: () => ({ collection: 'todos', where: { key }, orderBy: [] }),
			// The QueryStore subscribes with (rows, { onError, onCoverage }), failures as { error }.
			subscribe: (
				callback: (rows: CollectionRecord[]) => void,
				options?: { onError?: (failure: { error: Error }) => void },
			) => {
				emit = callback
				fail = options?.onError ? (error: Error) => options.onError?.({ error }) : null
				if (answer) callback(rows)
				return () => {}
			},
		} as unknown as QueryBuilder,
		emit: (next: CollectionRecord[]) => emit?.(next),
		fail: (error: Error) => fail?.(error),
	}
}
const rec = (id: string): CollectionRecord => ({ id, createdAt: 1, updatedAt: 1 })

/** Renders the probe and records every frame the snippet shows (rows, error message). */
function probe(query: QueryBuilder, onError?: (error: Error) => void) {
	const result = render(KoraQueryProbe, { props: { query, onError } })
	const frames: Array<{ rows: string; error: string }> = []
	const read = () => ({
		rows: result.container.querySelector('[data-testid="rows"]')?.textContent ?? '',
		error: result.container.querySelector('[data-testid="error"]')?.textContent ?? '',
	})
	const record = () => {
		const frame = read()
		const last = frames.at(-1)
		if (!last || last.rows !== frame.rows || last.error !== frame.error) frames.push(frame)
	}
	record()
	const observer = new MutationObserver(record)
	observer.observe(result.container, { subtree: true, childList: true, characterData: true })
	return { frames, ...result }
}

describe('KoraQuery', () => {
	it('passes a failed query to the snippet and its onError, never swallowing it', async () => {
		context.cache = new QueryStoreCache()
		const fake = fakeQuery('failing', [rec('a')])
		const onError = vi.fn()
		const { frames } = probe(fake.query, onError)
		const failure = new Error('query failed')
		fake.fail(failure)
		await vi.waitFor(() => expect(frames.at(-1)?.error).toBe('query failed'))
		expect(onError).toHaveBeenCalledWith(failure)
	})

	it('logs a failed query nobody handles', async () => {
		context.cache = new QueryStoreCache()
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		const fake = fakeQuery('unhandled', [rec('a')])
		probe(fake.query)
		fake.fail(new Error('nobody listens'))
		await vi.waitFor(() => expect(logged).toHaveBeenCalled())
	})

	it('keeps the previous rows until a new query answers: no empty frame', async () => {
		context.cache = new QueryStoreCache()
		const open = fakeQuery('open', [rec('o')])
		const done = fakeQuery('done', [rec('d')], false)
		const { container, rerender } = probe(open.query)
		const shown = () => container.querySelector('[data-testid="rows"]')?.textContent
		await vi.waitFor(() => expect(shown()).toBe('o'))
		// The filter changes; the new query has not answered yet.
		await rerender({ query: done.query })
		await tick()
		expect(shown()).toBe('o')
		done.emit([rec('d')])
		await vi.waitFor(() => expect(shown()).toBe('d'))
	})

	it('an equal query (a new builder, same descriptor) keeps its store and does not re-run', async () => {
		const cache = new QueryStoreCache()
		context.cache = cache
		const created = vi.spyOn(cache, 'getOrCreate')
		const first = fakeQuery('same', [rec('s')])
		const again = fakeQuery('same', [rec('s')])
		const { frames, rerender } = probe(first.query)
		await tick()
		await rerender({ query: again.query })
		await tick()
		expect(created).toHaveBeenCalledTimes(1)
		expect(frames.at(-1)?.rows).toBe('s')
	})
})
