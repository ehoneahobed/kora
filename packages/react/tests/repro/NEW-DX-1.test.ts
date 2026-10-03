// @vitest-environment node
import type { Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../../src/context/kora-context'
import { useCollaborators } from '../../src/hooks/use-collaborators'

/**
 * NEW-DX-1: useCollaborators called useSyncExternalStore without getServerSnapshot,
 * so React's server renderer threw "Missing getServerSnapshot" for any page that
 * shows presence. Correct: the server renders the empty peer list.
 */
function Peers() {
	const peers = useCollaborators()
	return createElement('span', null, `peers:${peers.length}`)
}

describe('NEW-DX-1 useCollaborators under SSR', () => {
	it('renderToString renders the empty peer list instead of throwing', () => {
		const store = { collection: vi.fn() } as unknown as Store
		const awareness = { on: vi.fn(() => () => {}), getStates: vi.fn(() => new Map()) }
		const syncEngine = {
			getAwarenessManager: () => awareness,
			getStatus: vi.fn(),
		} as unknown as SyncEngine
		let html = ''
		expect(() => {
			html = renderToString(
				createElement(KoraProvider, { store, syncEngine }, createElement(Peers)),
			)
		}).not.toThrow()
		expect(html).toContain('peers:0')
	})
})
