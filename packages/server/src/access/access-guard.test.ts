import { describe, expect, test } from 'vitest'
import type { ServerStore } from '../store/server-store'
import { readMembershipIntervals } from './access-guard'
import type { MembershipInterval } from './membership-index'

type State = { generation: string | null; rebuilding: boolean }

/** A store whose index state moves to `after` while the intervals are read. */
function storeChangingDuringRead(before: State, after: State): ServerStore {
	let state = before
	const base = {
		frontier: 0,
		accessCollectionsEver: [],
	}
	return {
		getAccessIndexState: async () => ({ ...base, ...state }),
		getMembershipIntervals: async (): Promise<MembershipInterval[]> => {
			state = after
			return []
		},
	} as unknown as ServerStore
}

describe('readMembershipIntervals', () => {
	test('returns the intervals with the generation both state reads agree on', async () => {
		const store = storeChangingDuringRead(
			{ generation: 'g1', rebuilding: false },
			{ generation: 'g1', rebuilding: false },
		)
		await expect(readMembershipIntervals(store, store, 'u')).resolves.toEqual({
			intervals: [],
			generation: 'g1',
		})
	})

	test('refuses retriably when a rebuild starts while the intervals are read', async () => {
		const store = storeChangingDuringRead(
			{ generation: 'g1', rebuilding: false },
			{ generation: 'g1', rebuilding: true },
		)
		await expect(readMembershipIntervals(store, store, 'u')).rejects.toMatchObject({
			context: { code: 'ACCESS_INDEX_NOT_READY' },
		})
	})

	test('refuses retriably when the generation rotates while the intervals are read', async () => {
		const store = storeChangingDuringRead(
			{ generation: 'g1', rebuilding: false },
			{ generation: 'g2', rebuilding: false },
		)
		await expect(readMembershipIntervals(store, store, 'u')).rejects.toMatchObject({
			context: { code: 'ACCESS_INDEX_NOT_READY' },
		})
	})

	test("reads the store's state when a transaction's view leaves the method out", async () => {
		const store = storeChangingDuringRead(
			{ generation: 'g1', rebuilding: false },
			{ generation: 'g1', rebuilding: true },
		)
		const view = { getMembershipIntervals: store.getMembershipIntervals } as unknown as ServerStore
		await expect(readMembershipIntervals(store, view, 'u')).rejects.toMatchObject({
			context: { code: 'ACCESS_INDEX_NOT_READY' },
		})
	})
})
