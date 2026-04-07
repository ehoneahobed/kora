import { describe, expect, test } from 'vitest'
import { getDefaultCreatePreferences } from './preferences'

describe('getDefaultCreatePreferences', () => {
	test('returns a fresh copy each call', () => {
		const first = getDefaultCreatePreferences()
		const second = getDefaultCreatePreferences()

		expect(first).toEqual(second)
		expect(first).not.toBe(second)
	})
})
