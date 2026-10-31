import type { CollectionRecord, QueryBuilder, QueryDescriptor } from '@korajs/store'
import { describe, expect, it, vi } from 'vitest'
import { DeferredQueryBuilder, type DeferredQueryHost, applyDescriptor } from './deferred-query'

interface FakeBuilder {
	subscribe: ReturnType<typeof vi.fn>
	exec: ReturnType<typeof vi.fn>
	count: ReturnType<typeof vi.fn>
}

function hostWith(builder: FakeBuilder): {
	host: DeferredQueryHost
	open: () => void
	fail: (error: Error) => void
} {
	let isOpen = false
	let resolveReady: () => void = () => {}
	let rejectReady: (error: Error) => void = () => {}
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve
		rejectReady = reject
	})
	return {
		host: {
			whenReady: () => ready,
			resolve: () => (isOpen ? (builder as unknown as QueryBuilder<CollectionRecord>) : null),
		},
		open: () => {
			isOpen = true
			resolveReady()
		},
		fail: (error) => rejectReady(error),
	}
}

const newBuilder = (): FakeBuilder => ({
	subscribe: vi.fn(() => vi.fn()),
	exec: vi.fn(async () => [{ id: '1' }]),
	count: vi.fn(async () => 3),
})

describe('DeferredQueryBuilder', () => {
	it('reports the descriptor the real builder will report', () => {
		const { host } = hostWith(newBuilder())
		const query = new DeferredQueryBuilder('todos', host, { done: false })
			.orderBy('title', 'desc')
			.limit(5)
			.offset(2)
			.include('project')
		expect(query.getDescriptor()).toEqual({
			collection: 'todos',
			where: { done: false },
			orderBy: [{ field: 'title', direction: 'desc' }],
			limit: 5,
			offset: 2,
			include: ['project'],
		})
	})

	it('does not share state between chained queries', () => {
		const { host } = hostWith(newBuilder())
		const base = new DeferredQueryBuilder('todos', host)
		base.where({ a: 1 })
		expect(base.getDescriptor().where).toEqual({})
	})

	it('delivers a subscription only after the store opens', async () => {
		const builder = newBuilder()
		const { host, open } = hostWith(builder)
		new DeferredQueryBuilder('todos', host).subscribe(() => {})
		expect(builder.subscribe).not.toHaveBeenCalled()
		open()
		await Promise.resolve()
		await Promise.resolve()
		expect(builder.subscribe).toHaveBeenCalledTimes(1)
	})

	it('does not subscribe when cancelled before the store opened', async () => {
		const builder = newBuilder()
		const { host, open } = hostWith(builder)
		const cancel = new DeferredQueryBuilder('todos', host).subscribe(() => {})
		cancel()
		open()
		await Promise.resolve()
		await Promise.resolve()
		expect(builder.subscribe).not.toHaveBeenCalled()
	})

	it('cancels the real subscription when cancelled after the swap', async () => {
		const stop = vi.fn()
		const builder = newBuilder()
		builder.subscribe.mockReturnValue(stop)
		const { host, open } = hostWith(builder)
		const cancel = new DeferredQueryBuilder('todos', host).subscribe(() => {})
		open()
		await Promise.resolve()
		await Promise.resolve()
		cancel()
		expect(stop).toHaveBeenCalledTimes(1)
	})

	it('reports a store that never opened through onError, not by throwing', async () => {
		const { host, fail } = hostWith(newBuilder())
		const onError = vi.fn()
		new DeferredQueryBuilder('todos', host).subscribe(() => {}, { onError })
		fail(new Error('boom'))
		await Promise.resolve()
		await Promise.resolve()
		expect(onError).toHaveBeenCalledTimes(1)
		expect(onError.mock.calls[0]?.[0]).toMatchObject({ phase: 'initial', collection: 'todos' })
	})

	it('exec and count wait for the store', async () => {
		const builder = newBuilder()
		const { host, open } = hostWith(builder)
		const query = new DeferredQueryBuilder('todos', host)
		const rows = query.exec()
		const total = query.count()
		open()
		expect(await rows).toEqual([{ id: '1' }])
		expect(await total).toBe(3)
	})
})

describe('applyDescriptor', () => {
	it('replays order, window and includes on a real builder', () => {
		const calls: string[] = []
		const real = {
			orderBy: (field: string, direction: string) => {
				calls.push(`order:${field}:${direction}`)
				return real
			},
			limit: (n: number) => {
				calls.push(`limit:${n}`)
				return real
			},
			offset: (n: number) => {
				calls.push(`offset:${n}`)
				return real
			},
			include: (...targets: string[]) => {
				calls.push(`include:${targets.join(',')}`)
				return real
			},
		} as unknown as QueryBuilder<CollectionRecord>
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: {},
			orderBy: [{ field: 'title', direction: 'asc' }],
			limit: 4,
			offset: 1,
			include: ['project'],
		}
		applyDescriptor(real, descriptor)
		expect(calls).toEqual(['order:title:asc', 'limit:4', 'offset:1', 'include:project'])
	})
})
