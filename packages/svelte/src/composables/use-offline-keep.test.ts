import type { OfflineKeepQuery } from '@korajs/core/bindings'
import { get } from 'svelte/store'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createOfflineKeepStore, useOfflineKeep } from './use-offline-keep'

const ctx: { app: unknown } = { app: null }

vi.mock('../context', () => ({
	getKoraContext: () => ctx,
}))

afterEach(() => {
	ctx.app = null
})

const query = (where: Record<string, unknown>) =>
	({ getDescriptor: () => ({ collection: 'lessons', where }) }) as OfflineKeepQuery

function fakeApp(refuse?: Error) {
	const holds: Array<{ released: boolean }> = []
	ctx.app = {
		offline: {
			hold: async () => {
				if (refuse) throw refuse
				const hold = { released: false }
				holds.push(hold)
				return async () => {
					hold.released = true
				}
			},
		},
	}
	return holds
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('createOfflineKeepStore', () => {
	test('is aliased as useOfflineKeep', () => {
		expect(useOfflineKeep).toBe(createOfflineKeepStore)
	})

	test('holds the pin, reports it, and releases on demand (outside a component)', async () => {
		const holds = fakeApp()
		const store = createOfflineKeepStore(query({ courseId: 'c1' }), { files: true })
		expect(get(store)).toEqual({ held: false, error: null })
		await flush()
		expect(get(store)).toEqual({ held: true, error: null })
		expect(holds.filter((hold) => !hold.released)).toHaveLength(1)
		store.release()
		await flush()
		expect(holds.filter((hold) => !hold.released)).toHaveLength(0)
		expect(get(store).held).toBe(false)
		store.release()
	})

	test('reports a refused hold', async () => {
		fakeApp(new Error('64 pins'))
		const store = createOfflineKeepStore(query({ courseId: 'c1' }))
		await flush()
		expect(get(store)).toEqual({
			held: false,
			error: expect.objectContaining({ message: '64 pins' }),
		})
	})

	test('does nothing without app.offline', async () => {
		const store = createOfflineKeepStore(query({}))
		await flush()
		expect(get(store)).toEqual({ held: false, error: null })
	})
})
