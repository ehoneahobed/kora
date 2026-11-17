// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { OrgClient } from '../client/org-client'
import { OrgProvider } from './OrgProvider'
import { useOrg } from './org-hooks'

/**
 * OrgProvider under React StrictMode, which runs every effect's cleanup and setup once more on
 * mount. The org session must survive that, so useOrg follows client.switchOrg.
 */
function fakeClient() {
	const listeners = new Set<(orgId: string | null) => void>()
	let active: string | null = 'org-a'
	const client = {
		get activeOrgId() {
			return active
		},
		get activeOrg() {
			return active ? { id: active, name: active } : null
		},
		get activeRole() {
			return active ? 'member' : null
		},
		onOrgChange: vi.fn((listener: (orgId: string | null) => void) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		}),
		async switchOrg(orgId: string) {
			active = orgId
			for (const listener of listeners) listener(orgId)
		},
	}
	return { client: client as unknown as OrgClient & typeof client, listeners }
}

function ActiveOrg() {
	const { orgId } = useOrg()
	return createElement('p', { 'data-testid': 'org' }, orgId ?? 'none')
}

afterEach(() => cleanup())

describe('OrgProvider under StrictMode', () => {
	test('useOrg follows client.switchOrg', async () => {
		const { client } = fakeClient()
		render(
			createElement(
				StrictMode,
				null,
				createElement(OrgProvider, { client }, createElement(ActiveOrg)),
			),
		)
		expect(screen.getByTestId('org').textContent).toBe('org-a')
		await act(async () => {
			await client.switchOrg('org-b')
		})
		expect(screen.getByTestId('org').textContent).toBe('org-b')
	})

	test('unmounting releases the onOrgChange listener', async () => {
		const { client, listeners } = fakeClient()
		const view = render(
			createElement(
				StrictMode,
				null,
				createElement(OrgProvider, { client }, createElement(ActiveOrg)),
			),
		)
		expect(listeners.size).toBe(1)
		view.unmount()
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10))
		})
		expect(listeners.size).toBe(0)
	})
})
