// @vitest-environment node
import type { QueryBuilder, Store } from '@korajs/store'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../../src/context/kora-context'
import { useQuery } from '../../src/hooks/use-query'

/**
 * DX-6: server rendering (Next.js/Remix SSR) of a component using useQuery.
 * useQuery calls useSyncExternalStore without getServerSnapshot, so React's
 * server renderer throws "Missing getServerSnapshot". Correct: SSR renders an
 * empty/initial list without throwing.
 */
function List({ query }: { query: QueryBuilder }) {
	const rows = useQuery(query)
	return createElement('ul', null, String(rows.length))
}

describe('DX-6 useQuery under SSR', () => {
	it('renderToString does not throw', () => {
		const store = { collection: vi.fn() } as unknown as Store
		const query = {
			subscribe: vi.fn(() => () => {}),
			getDescriptor: vi.fn().mockReturnValue({ collection: 'todos', where: {}, orderBy: [] }),
		} as unknown as QueryBuilder
		expect(() =>
			renderToString(createElement(KoraProvider, { store }, createElement(List, { query }))),
		).not.toThrow()
	})
})
