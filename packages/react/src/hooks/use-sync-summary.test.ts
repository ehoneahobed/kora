import type { Store } from '@korajs/store'
import type { SyncEngine, SyncStatusInfo } from '@korajs/sync'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import { useSyncSummary } from './use-sync-summary'

afterEach(() => cleanup())

const store = {
	collection: vi.fn(),
	getSchema: vi.fn(),
	getVersionVector: vi.fn(),
	getNodeId: vi.fn(),
} as unknown as Store

function engine(status: Partial<SyncStatusInfo>): SyncEngine {
	const info: SyncStatusInfo = {
		status: 'offline',
		reconnecting: false,
		pendingOperations: 0,
		lastSyncedAt: null,
		lastSuccessfulPush: null,
		lastSuccessfulPull: null,
		conflicts: 0,
		clockSkewMs: null,
		...status,
	}
	return { getStatus: vi.fn(() => info), start: vi.fn(), stop: vi.fn() } as unknown as SyncEngine
}

function Chip(): ReturnType<typeof createElement> {
	const sync = useSyncSummary()
	return createElement(
		'span',
		{ 'data-testid': 'chip', 'data-tone': sync.tone },
		`${sync.title} · ${sync.detail}`,
	)
}

describe('useSyncSummary', () => {
	it('summarizes the engine status for an indicator', () => {
		render(
			createElement(
				KoraProvider,
				{ store, syncEngine: engine({ status: 'offline', pendingOperations: 2 }) },
				createElement(Chip),
			),
		)
		const chip = screen.getByTestId('chip')
		expect(chip.textContent).toBe('Offline · 2 changes saved on this device')
		expect(chip.getAttribute('data-tone')).toBe('working')
	})

	it('an app without sync is local only, never "offline"', () => {
		render(createElement(KoraProvider, { store }, createElement(Chip)))
		expect(screen.getByTestId('chip').textContent).toBe(
			'On this device · Everything is saved on this device',
		)
	})
})
