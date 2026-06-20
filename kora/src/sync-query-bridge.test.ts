import { describe, expect, test } from 'vitest'
import { queryDescriptorToSyncSubset } from './sync-query-bridge'

describe('queryDescriptorToSyncSubset', () => {
	test('extracts equality filters', () => {
		expect(
			queryDescriptorToSyncSubset({
				collection: 'todos',
				where: { completed: false, userId: 'u-1' },
				orderBy: [],
			}),
		).toEqual({
			collection: 'todos',
			where: { completed: false, userId: 'u-1' },
		})
	})

	test('returns null for operator-based filters', () => {
		expect(
			queryDescriptorToSyncSubset({
				collection: 'todos',
				where: { createdAt: { $gt: 1000 } },
				orderBy: [],
			}),
		).toBeNull()
	})

	test('returns null when where is empty', () => {
		expect(
			queryDescriptorToSyncSubset({
				collection: 'todos',
				where: {},
				orderBy: [],
			}),
		).toBeNull()
	})
})
