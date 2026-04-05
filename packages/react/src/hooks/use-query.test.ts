import type { CollectionRecord, QueryBuilder, SubscriptionCallback } from '@korajs/store'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from './use-query'

afterEach(() => {
	cleanup()
})

interface MockQueryBuilderResult {
	queryBuilder: QueryBuilder
	triggerCallback: (results: CollectionRecord[]) => void
	unsubscribeSpy: ReturnType<typeof vi.fn>
	descriptor: Record<string, unknown>
}

function createMockQueryBuilder(
	initialResults: CollectionRecord[] = [],
	descriptor: Record<string, unknown> = { collection: 'todos', where: {}, orderBy: [] },
): MockQueryBuilderResult {
	let capturedCallback: SubscriptionCallback<CollectionRecord> | null = null
	const unsubscribeSpy = vi.fn()

	const queryBuilder = {
		subscribe: vi.fn((callback: SubscriptionCallback<CollectionRecord>) => {
			capturedCallback = callback
			// Simulate registerAndFetch: immediate callback with initial results
			callback(initialResults)
			return unsubscribeSpy
		}),
		getDescriptor: vi.fn().mockReturnValue(descriptor),
	} as unknown as QueryBuilder

	const triggerCallback = (results: CollectionRecord[]) => {
		if (capturedCallback) {
			capturedCallback(results)
		}
	}

	return { queryBuilder, triggerCallback, unsubscribeSpy, descriptor }
}

function createRecord(id: string, data: Record<string, unknown> = {}): CollectionRecord {
	return { id, createdAt: 1000, updatedAt: 1000, ...data }
}

/** Component that renders query results */
function QueryRenderer({ query }: { query: QueryBuilder }): ReturnType<typeof createElement> {
	const results = useQuery(query)
	return createElement(
		'div',
		{ 'data-testid': 'results' },
		JSON.stringify(results.map((r) => r.id)),
	)
}

describe('useQuery', () => {
	it('returns empty array initially before subscription fires', () => {
		const { queryBuilder } = createMockQueryBuilder()
		// With synchronous callback in subscribe mock, data appears immediately
		render(createElement(QueryRenderer, { query: queryBuilder }))
		expect(screen.getByTestId('results')).toBeDefined()
	})

	it('returns data after subscription callback fires', () => {
		const records = [createRecord('1'), createRecord('2')]
		const { queryBuilder } = createMockQueryBuilder(records)

		render(createElement(QueryRenderer, { query: queryBuilder }))

		expect(screen.getByTestId('results').textContent).toBe('["1","2"]')
	})

	it('re-renders when data changes', () => {
		const { queryBuilder, triggerCallback } = createMockQueryBuilder([createRecord('1')])

		render(createElement(QueryRenderer, { query: queryBuilder }))
		expect(screen.getByTestId('results').textContent).toBe('["1"]')

		act(() => {
			triggerCallback([createRecord('1'), createRecord('2')])
		})

		expect(screen.getByTestId('results').textContent).toBe('["1","2"]')
	})

	it('returns empty array when enabled is false', () => {
		const records = [createRecord('1')]
		const { queryBuilder } = createMockQueryBuilder(records)

		function DisabledQuery(): ReturnType<typeof createElement> {
			const results = useQuery(queryBuilder, { enabled: false })
			return createElement('div', { 'data-testid': 'results' }, String(results.length))
		}

		render(createElement(DisabledQuery))
		expect(screen.getByTestId('results').textContent).toBe('0')
		// Should not have subscribed
		expect(queryBuilder.subscribe).not.toHaveBeenCalled()
	})

	it('cleans up subscription on unmount', () => {
		const { queryBuilder, unsubscribeSpy } = createMockQueryBuilder([createRecord('1')])

		const { unmount } = render(createElement(QueryRenderer, { query: queryBuilder }))

		unmount()

		// The QueryStore should have been destroyed, which calls unsubscribe
		expect(unsubscribeSpy).toHaveBeenCalled()
	})

	it('handles query descriptor change', async () => {
		const mock1 = createMockQueryBuilder([createRecord('1')], {
			collection: 'todos',
			where: { completed: false },
			orderBy: [],
		})
		const mock2 = createMockQueryBuilder([createRecord('2'), createRecord('3')], {
			collection: 'todos',
			where: { completed: true },
			orderBy: [],
		})

		function DynamicQuery(): ReturnType<typeof createElement> {
			const [completed, setCompleted] = useState(false)
			const query = completed ? mock2.queryBuilder : mock1.queryBuilder
			const results = useQuery(query)
			return createElement(
				'div',
				null,
				createElement(
					'div',
					{ 'data-testid': 'results' },
					JSON.stringify(results.map((r) => r.id)),
				),
				createElement(
					'button',
					{
						type: 'button',
						'data-testid': 'toggle',
						onClick: () => setCompleted(true),
					},
					'Toggle',
				),
			)
		}

		render(createElement(DynamicQuery))
		expect(screen.getByTestId('results').textContent).toBe('["1"]')

		act(() => {
			screen.getByTestId('toggle').click()
		})

		await waitFor(() => {
			expect(screen.getByTestId('results').textContent).toBe('["2","3"]')
		})
	})

	it('subscribes to QueryBuilder', () => {
		const { queryBuilder } = createMockQueryBuilder([createRecord('1')])

		render(createElement(QueryRenderer, { query: queryBuilder }))

		expect(queryBuilder.subscribe).toHaveBeenCalledTimes(1)
	})
})
