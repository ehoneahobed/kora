import { describe, expect, test } from 'vitest'
import type { QueryBuilder } from '../query/query-builder'
import { assertQueryReady } from './assert-query-ready'

describe('assertQueryReady', () => {
	test('throws when collection is __pending__', () => {
		const pending = {
			getDescriptor: () => ({
				collection: '__pending__',
				where: {},
				orderBy: [],
			}),
		} as QueryBuilder<unknown>

		expect(() => assertQueryReady(pending)).toThrow(/app\.ready/)
	})

	test('allows a real collection descriptor', () => {
		const query = {
			getDescriptor: () => ({
				collection: 'todos',
				where: {},
				orderBy: [],
			}),
		} as QueryBuilder<unknown>

		expect(() => assertQueryReady(query)).not.toThrow()
	})
})
