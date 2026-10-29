import { describe, expect, test } from 'vitest'
import { holdOfflineKeep } from './hold-offline-keep'

const query = { getDescriptor: () => ({ collection: 'lessons', where: {} }) }

function fakeOffline() {
	const log: string[] = []
	let held = 0
	return {
		log,
		held: () => held,
		offline: {
			hold: async () => {
				held++
				log.push('hold')
				return async () => {
					held--
					log.push('release')
				}
			},
		},
	}
}

describe('holdOfflineKeep', () => {
	test('releases the hold it took, once', async () => {
		const fake = fakeOffline()
		const hold = holdOfflineKeep(fake.offline, query)
		await hold.recorded
		hold.release()
		hold.release()
		await Promise.resolve()
		expect(fake.log).toEqual(['hold', 'release'])
		expect(fake.held()).toBe(0)
	})

	test('a release before the hold was recorded undoes it as soon as it is', async () => {
		const fake = fakeOffline()
		const hold = holdOfflineKeep(fake.offline, query)
		hold.release()
		await hold.recorded
		await Promise.resolve()
		expect(fake.held()).toBe(0)
	})

	test('reports why a hold was refused', async () => {
		const hold = holdOfflineKeep(
			{
				hold: async () => {
					throw new Error('limit')
				},
			},
			query,
		)
		await expect(hold.recorded).rejects.toThrow('limit')
		hold.release()
	})
})
