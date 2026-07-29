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

	test('widens operator-only filters to a collection-wide subset', () => {
		expect(
			queryDescriptorToSyncSubset({
				collection: 'todos',
				where: { createdAt: { $gt: 1000 } },
				orderBy: [],
			}),
		).toEqual({
			collection: 'todos',
			where: {},
		})
	})

	test('registers empty where as a collection-wide subset', () => {
		expect(
			queryDescriptorToSyncSubset({
				collection: 'todos',
				where: {},
				orderBy: [],
			}),
		).toEqual({
			collection: 'todos',
			where: {},
		})
	})

	test('keeps equality filters when unsupported filters are also present', () => {
		expect(
			queryDescriptorToSyncSubset({
				collection: 'todos',
				where: { ownerId: 'u-1', createdAt: { $gt: 1000 } },
				orderBy: [],
			}),
		).toEqual({
			collection: 'todos',
			where: { ownerId: 'u-1' },
		})
	})
})
