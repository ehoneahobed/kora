import { act, cleanup, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { hydrateRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeQuery, createFakeStore, row } from '../../tests/fixtures/fake-query'
import { KoraProvider } from '../context/kora-context'
import { useCollaborators } from './use-collaborators'
import { useQuery } from './use-query'
import { useSyncStatus } from './use-sync-status'

let root: Root | null = null

afterEach(() => {
	act(() => root?.unmount())
	root = null
	cleanup()
	vi.restoreAllMocks()
})

// DX-6: the server HTML and the client's first (hydration) render must agree, then
// the client fills in local data.
describe('hydration (DX-6)', () => {
	it('hydrates server HTML without a mismatch, then shows local rows', async () => {
		const fake = createFakeQuery('hydrate', [row('a'), row('b')])
		const store = createFakeStore()
		function List() {
			const rows = useQuery(fake.query)
			const status = useSyncStatus()
			const peers = useCollaborators()
			return createElement(
				'ul',
				{ 'data-status': status.status, 'data-peers': peers.length },
				rows.map((r) => createElement('li', { key: r.id }, r.id)),
			)
		}
		const tree = () => createElement(KoraProvider, { store }, createElement(List))

		const html = renderToString(tree())
		expect(html).toContain('<ul data-status="offline" data-peers="0"></ul>')

		const container = document.createElement('div')
		container.innerHTML = html
		document.body.appendChild(container)
		const recoverable: unknown[] = []
		const consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => {})

		await act(async () => {
			root = hydrateRoot(container, tree(), {
				onRecoverableError: (error) => {
					recoverable.push(error)
				},
			})
		})

		await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(2))
		expect(recoverable).toEqual([])
		expect(consoleErrors).not.toHaveBeenCalled()

		act(() => fake.emit([row('a'), row('b'), row('c')]))
		expect(container.querySelectorAll('li')).toHaveLength(3)
		container.remove()
	})
})
