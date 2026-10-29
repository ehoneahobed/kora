import { describe, expect, it } from 'vitest'
import { OfflineAssertionError } from './errors'
import {
	hasReason,
	isOfflineStatus,
	isTransientEvaluationError,
	readOfflineStatus,
	readStatusFrom,
	toPredicate,
	waitForOfflineStatus,
} from './status'
import type { OfflineStatusLike } from './types'

const status = (state: OfflineStatusLike['state'], reasons: string[] = []): OfflineStatusLike => ({
	state,
	reasons,
})

/** A page whose evaluations run `readStatusFrom` against a scripted root. */
function pageWith(roots: Array<unknown | Error>) {
	let reads = 0
	return {
		get reads() {
			return reads
		},
		evaluate: async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
			const root = roots[Math.min(reads, roots.length - 1)]
			reads += 1
			if (root instanceof Error) throw root
			return fn({ ...(arg as object), root } as A)
		},
	}
}

describe('readStatusFrom', () => {
	it('resolves a dotted accessor and returns a plain snapshot', () => {
		const root = { app: { offline: { status: () => ({ state: 'ready', reasons: [] }) } } }
		expect(readStatusFrom({ accessor: 'app.offline', root })).toEqual({
			state: 'ready',
			reasons: [],
		})
	})

	it('honours a custom accessor', () => {
		const root = {
			kora: { app: { offline: { status: () => status('preparing', ['shell-installing']) } } },
		}
		expect(readStatusFrom({ accessor: 'kora.app.offline', root })).toEqual(
			status('preparing', ['shell-installing']),
		)
	})

	it('returns null while the app does not exist yet', () => {
		expect(readStatusFrom({ accessor: 'app.offline', root: {} })).toBeNull()
		expect(readStatusFrom({ accessor: 'app.offline', root: { app: null } })).toBeNull()
	})

	it('returns null when the target is not an offline handle or throws', () => {
		expect(readStatusFrom({ accessor: 'app', root: { app: {} } })).toBeNull()
		expect(
			readStatusFrom({
				accessor: 'app.offline',
				root: {
					app: {
						offline: {
							status: () => {
								throw new Error('not ready')
							},
						},
					},
				},
			}),
		).toBeNull()
		expect(
			readStatusFrom({ accessor: 'app.offline', root: { app: { offline: { status: () => 3 } } } }),
		).toBeNull()
	})

	it('copies frozen and class-instance snapshots into plain data', () => {
		class Snapshot {
			state = 'ready'
			reasons: string[] = []
		}
		const root = { app: { offline: { status: () => Object.freeze(new Snapshot()) } } }
		const out = readStatusFrom({ accessor: 'app.offline', root })
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
	})
})

describe('isOfflineStatus and predicates', () => {
	it('accepts only the three states with a reasons array', () => {
		expect(isOfflineStatus(status('ready'))).toBe(true)
		expect(isOfflineStatus({ state: 'weird', reasons: [] })).toBe(false)
		expect(isOfflineStatus({ state: 'ready' })).toBe(false)
		expect(isOfflineStatus(null)).toBe(false)
	})

	it('toPredicate accepts a state name or a function', () => {
		expect(toPredicate('ready')(status('ready'))).toBe(true)
		expect(toPredicate('ready')(status('preparing'))).toBe(false)
		expect(toPredicate((s) => s.reasons.length === 2)(status('not-ready', ['a', 'b']))).toBe(true)
	})

	it('hasReason matches a listed reason', () => {
		expect(hasReason('data-incomplete')(status('not-ready', ['data-incomplete']))).toBe(true)
		expect(hasReason('data-incomplete')(status('ready'))).toBe(false)
	})

	it('classifies navigation races as transient', () => {
		expect(isTransientEvaluationError(new Error('Execution context was destroyed'))).toBe(true)
		expect(
			isTransientEvaluationError(new Error('Target page, context or browser has been closed')),
		).toBe(true)
		expect(isTransientEvaluationError(new Error('boom'))).toBe(false)
	})
})

describe('readOfflineStatus', () => {
	it('returns null for a transient evaluation error and rethrows others', async () => {
		await expect(
			readOfflineStatus(pageWith([new Error('Execution context was destroyed')])),
		).resolves.toBeNull()
		await expect(readOfflineStatus(pageWith([new Error('boom')]))).rejects.toThrow('boom')
	})
})

describe('waitForOfflineStatus', () => {
	const offlineRoot = (s: OfflineStatusLike) => ({ app: { offline: { status: () => s } } })

	it('returns the first matching status', async () => {
		const page = pageWith([
			{},
			offlineRoot(status('preparing', ['shell-installing'])),
			offlineRoot(status('ready')),
		])
		const sleeps: number[] = []
		const result = await waitForOfflineStatus(page, 'ready', {
			sleep: async (ms) => {
				sleeps.push(ms)
			},
		})
		expect(result.state).toBe('ready')
		expect(page.reads).toBe(3)
		expect(sleeps).toEqual([50, 50])
	})

	it('survives a navigation in the middle of the wait', async () => {
		const page = pageWith([
			new Error('Execution context was destroyed, most likely because of a navigation'),
			offlineRoot(status('ready')),
		])
		await expect(
			waitForOfflineStatus(page, 'ready', { sleep: async () => {} }),
		).resolves.toMatchObject({
			state: 'ready',
		})
	})

	it('times out with the last status in the message', async () => {
		let clock = 0
		const page = pageWith([offlineRoot(status('not-ready', ['data-incomplete']))])
		const error = await waitForOfflineStatus(page, 'ready', {
			timeoutMs: 100,
			pollMs: 40,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms
			},
		}).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(OfflineAssertionError)
		expect((error as OfflineAssertionError).code).toBe('OFFLINE_STATUS_TIMEOUT')
		expect((error as OfflineAssertionError).message).toContain('data-incomplete')
	})

	it('names the accessor when the handle never appears', async () => {
		let clock = 0
		const error = await waitForOfflineStatus(pageWith([{}]), 'ready', {
			accessor: 'myApp.offline',
			timeoutMs: 10,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms
			},
		}).catch((e: unknown) => e)
		expect((error as OfflineAssertionError).message).toContain('myApp.offline')
	})
})
