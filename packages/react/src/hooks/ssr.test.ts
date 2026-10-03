// @vitest-environment node
import type { SyncEngine } from '@korajs/sync'
import { OFFLINE_SYNC_STATUS } from '@korajs/sync'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
	createFakeApp,
	createFakeQuery,
	createFakeStore,
	row,
} from '../../tests/fixtures/fake-query'
import { KoraProvider } from '../context/kora-context'
import { useCollaborators } from './use-collaborators'
import { useMutation } from './use-mutation'
import { useQuery, useQueryState } from './use-query'
import { useSyncStatus } from './use-sync-status'

// DX-6 / NEW-DX-1: every hook renders under React's server renderer, with the values a
// device without a local database has: no rows, offline, no peers.
function Page({ query }: { query: ReturnType<typeof createFakeQuery>['query'] }) {
	const rows = useQuery(query)
	const state = useQueryState(query)
	const status = useSyncStatus()
	const peers = useCollaborators()
	const { isLoading } = useMutation(async () => 1)
	return createElement(
		'main',
		null,
		`rows:${rows.length} ready:${String(state.ready)} error:${String(state.error)} status:${status.status} peers:${peers.length} loading:${String(isLoading)}`,
	)
}

describe('server rendering (DX-6, NEW-DX-1)', () => {
	it('renders every hook with its empty server snapshot', () => {
		const fake = createFakeQuery('ssr', [row('a')])
		const awareness = { on: vi.fn(() => () => {}), getStates: vi.fn(() => new Map()) }
		const syncEngine = {
			getAwarenessManager: () => awareness,
			getStatus: vi.fn(() => ({ ...OFFLINE_SYNC_STATUS, status: 'synced' })),
		} as unknown as SyncEngine
		const html = renderToString(
			createElement(
				KoraProvider,
				{ store: createFakeStore(), syncEngine },
				createElement(Page, { query: fake.query }),
			),
		)
		expect(html).toContain('rows:0 ready:false error:null')
		expect(html).toContain('peers:0 loading:false')
		// The server never subscribes to the local database.
		expect(fake.subscribeCount()).toBe(0)
	})

	it('<KoraProvider app={app}> renders its fallback on the server', () => {
		const fake = createFakeQuery('ssr-app', [row('a')])
		const html = renderToString(
			createElement(
				KoraProvider,
				{ app: createFakeApp({}), fallback: createElement('p', null, 'loading') },
				createElement(Page, { query: fake.query }),
			),
		)
		expect(html).toBe('<p>loading</p>')
	})
})
