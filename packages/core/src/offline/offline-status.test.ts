import { describe, expect, test } from 'vitest'
import {
	OFFLINE_STATUS_SERVER_RENDER,
	OFFLINE_STATUS_UNKNOWN,
	type OfflineStateInputs,
	computeOfflineState,
} from './offline-status'

function inputs(overrides: Partial<OfflineStateInputs> = {}): OfflineStateInputs {
	return {
		shell: { state: 'installed', version: 'v1', misses: [] },
		data: { state: 'complete', progress: 1, completedAt: 1, quarantined: 0 },
		files: { kept: 0, missing: 0, bytesMissing: 0, failed: 0 },
		storage: {
			backend: 'opfs',
			durable: true,
			blobStoreDurable: true,
			persisted: true,
			writes: 'durable',
			usage: null,
			quota: null,
			evicted: null,
		},
		auth: { state: 'n/a', offlineUntil: null },
		dataBlocked: false,
		pinsComplete: true,
		filesKept: false,
		filesDownloading: false,
		sessionLive: false,
		serverRendering: false,
		otherTab: false,
		uncoordinated: false,
		now: 1_000,
		...overrides,
	}
}

describe('computeOfflineState', () => {
	test('every component holding is ready, with no reasons', () => {
		expect(computeOfflineState(inputs())).toEqual({ state: 'ready', reasons: [] })
	})

	test('bundled shell and local data hold', () => {
		const result = computeOfflineState(
			inputs({
				shell: { state: 'bundled', version: null, misses: [] },
				data: { state: 'local', progress: null, completedAt: null, quarantined: 0 },
			}),
		)
		expect(result.state).toBe('ready')
	})

	const shellCases: Array<[OfflineStateInputs['shell']['state'], string, string]> = [
		['installing', 'shell-installing', 'preparing'],
		['not-installed', 'shell-not-installed', 'not-ready'],
		['other-build', 'shell-other-build', 'not-ready'],
		['unsupported', 'shell-unsupported', 'not-ready'],
		['none', 'shell-none', 'not-ready'],
	]
	test.each(shellCases)('shell %s -> %s (%s)', (state, reason, expected) => {
		const result = computeOfflineState(inputs({ shell: { state, version: null, misses: [] } }))
		expect(result.reasons).toEqual([reason])
		expect(result.state).toBe(expected)
	})

	test('data syncing on a live session is preparing; without a session it is not-ready', () => {
		const data = { state: 'syncing', progress: 0.5, completedAt: null, quarantined: 0 } as const
		expect(computeOfflineState(inputs({ data, sessionLive: true }))).toEqual({
			state: 'preparing',
			reasons: ['data-syncing'],
		})
		expect(computeOfflineState(inputs({ data, sessionLive: false })).state).toBe('not-ready')
	})

	test('data incomplete is never ready or preparing', () => {
		const data = { state: 'incomplete', progress: null, completedAt: null, quarantined: 0 } as const
		expect(computeOfflineState(inputs({ data, sessionLive: true }))).toEqual({
			state: 'not-ready',
			reasons: ['data-incomplete'],
		})
	})

	test('a blocked delivery outranks the data state', () => {
		const result = computeOfflineState(inputs({ dataBlocked: true, sessionLive: true }))
		expect(result).toEqual({ state: 'not-ready', reasons: ['data-blocked'] })
	})

	test('a pin that is not complete holds ready back, preparing only on a live session', () => {
		expect(computeOfflineState(inputs({ pinsComplete: false, sessionLive: true })).state).toBe(
			'preparing',
		)
		expect(computeOfflineState(inputs({ pinsComplete: false })).state).toBe('not-ready')
	})

	test('files: downloading is progress, missing and failed are not', () => {
		const files = { kept: 3, missing: 2, bytesMissing: 10, failed: 0 }
		expect(computeOfflineState(inputs({ files, filesDownloading: true }))).toEqual({
			state: 'preparing',
			reasons: ['files-downloading'],
		})
		expect(computeOfflineState(inputs({ files })).reasons).toEqual(['files-missing'])
		expect(
			computeOfflineState(inputs({ files: { ...files, failed: 1 }, filesDownloading: true }))
				.reasons,
		).toEqual(['files-failed'])
	})

	test('storage: non-durable database, failing writes and a non-durable blob store with kept files', () => {
		const storage = inputs().storage
		expect(
			computeOfflineState(inputs({ storage: { ...storage, durable: false } })).reasons,
		).toEqual(['storage-non-durable'])
		expect(
			computeOfflineState(inputs({ storage: { ...storage, writes: 'failing' } })).reasons,
		).toEqual(['storage-writes-failing'])
		const blob = { ...storage, blobStoreDurable: false }
		expect(computeOfflineState(inputs({ storage: blob })).state).toBe('ready')
		expect(computeOfflineState(inputs({ storage: blob, filesKept: true })).reasons).toEqual([
			'storage-non-durable',
		])
	})

	test('auth: restorable holds until offlineUntil; loading is progress; unknown never holds', () => {
		const restorable = (offlineUntil: number | null) => ({
			state: 'restorable' as const,
			offlineUntil,
		})
		expect(computeOfflineState(inputs({ auth: restorable(null) })).state).toBe('ready')
		expect(computeOfflineState(inputs({ auth: restorable(2_000) })).state).toBe('ready')
		expect(computeOfflineState(inputs({ auth: restorable(1_000) })).reasons).toEqual([
			'auth-not-restorable',
		])
		expect(computeOfflineState(inputs({ auth: { state: 'loading', offlineUntil: null } }))).toEqual(
			{ state: 'preparing', reasons: ['auth-loading'] },
		)
		expect(
			computeOfflineState(inputs({ auth: { state: 'unknown', offlineUntil: null } })).reasons,
		).toEqual(['auth-unknown'])
		expect(
			computeOfflineState(inputs({ auth: { state: 'not-restorable', offlineUntil: null } }))
				.reasons,
		).toEqual(['auth-not-restorable'])
	})

	test('server rendering, another tab and uncoordinated tabs are never ready', () => {
		expect(computeOfflineState(inputs({ serverRendering: true })).reasons).toEqual([
			'server-rendering',
		])
		expect(computeOfflineState(inputs({ otherTab: true })).reasons).toEqual(['storage-other-tab'])
		expect(computeOfflineState(inputs({ uncoordinated: true })).reasons).toEqual([
			'storage-uncoordinated',
		])
	})

	test('persisted: false, quarantined operations and an eviction alone never change ready', () => {
		const base = inputs()
		const result = computeOfflineState(
			inputs({
				storage: {
					...base.storage,
					persisted: false,
					evicted: {
						dbName: 'x',
						detectedAt: 1,
						lastOpenedAt: null,
						evidence: ['manifest'],
						lostWrites: { count: 2, certain: true },
					},
				},
				data: { state: 'complete', progress: 1, completedAt: 1, quarantined: 7 },
				shell: { state: 'installed', version: 'v', misses: ['/a.js'] },
			}),
		)
		expect(result).toEqual({ state: 'ready', reasons: [] })
	})

	test('a stalled component outweighs one that is progressing', () => {
		const result = computeOfflineState(
			inputs({
				shell: { state: 'installing', version: null, misses: [] },
				storage: { ...inputs().storage, durable: false },
			}),
		)
		expect(result.state).toBe('not-ready')
		expect(result.reasons).toEqual(['shell-installing', 'storage-non-durable'])
	})

	test('the placeholders are never ready and are frozen', () => {
		expect(OFFLINE_STATUS_UNKNOWN.state).toBe('not-ready')
		expect(OFFLINE_STATUS_UNKNOWN.reasons.length).toBeGreaterThan(0)
		expect(OFFLINE_STATUS_SERVER_RENDER.reasons).toEqual(['server-rendering'])
		expect(Object.isFrozen(OFFLINE_STATUS_UNKNOWN)).toBe(true)
	})
})
