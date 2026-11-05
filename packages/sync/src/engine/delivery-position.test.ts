import { describe, expect, test } from 'vitest'
import { DeliveryPosition } from './delivery-position'

describe('DeliveryPosition', () => {
	test('starts at zero with no key and no views', () => {
		const position = new DeliveryPosition()
		expect(position.watermark).toBe(0)
		expect(position.rulesKey).toBeNull()
		expect(position.viewCount).toBe(0)
		expect(position.viewSignatures()).toEqual([])
		expect(position.viewWatermark('a')).toBeUndefined()
	})

	test('the owner methods move the watermark and the key', () => {
		const position = new DeliveryPosition()
		position.moveTo(7)
		position.adoptRulesKey('K')
		expect(position.watermark).toBe(7)
		expect(position.rulesKey).toBe('K')
		position.adoptRulesKey(null)
		expect(position.rulesKey).toBeNull()
	})

	test('the writer advances the watermark and adopts the key, and only those', () => {
		const position = new DeliveryPosition()
		position.recordView('v', 3)
		position.writer.advance(9)
		position.writer.adoptKey('K2')
		expect(position.watermark).toBe(9)
		expect(position.rulesKey).toBe('K2')
		expect(position.viewWatermark('v')).toBe(3)
		expect(position.writer).toBe(position.writer)
	})

	test('the view cache keeps least-recently-used order', () => {
		const position = new DeliveryPosition()
		position.recordView('a', 1)
		position.recordView('b', 2)
		position.preloadView('c', 3)
		position.recordView('a', 4)
		expect(position.viewSignatures()).toEqual(['b', 'c', 'a'])
		expect(position.viewWatermark('a')).toBe(4)
		expect(position.viewCount).toBe(3)
		// Preloading an entry already there updates it without a recency change.
		position.preloadView('b', 8)
		expect(position.viewSignatures()).toEqual(['b', 'c', 'a'])
		expect(position.viewWatermark('b')).toBe(8)
		position.forgetView('b')
		expect(position.viewSignatures()).toEqual(['c', 'a'])
		expect(position.viewWatermark('b')).toBeUndefined()
	})

	test('the cache handed out is a copy: writing to it changes nothing', () => {
		const position = new DeliveryPosition()
		position.recordView('a', 1)
		const copy = position.views as Map<string, number>
		copy.set('a', 99)
		copy.set('b', 5)
		expect(position.viewWatermark('a')).toBe(1)
		expect(position.viewCount).toBe(1)
	})

	test('the state is private: no own property, no JSON, no reflective reach', () => {
		const position = new DeliveryPosition()
		position.writer.advance(5)
		expect(Object.getOwnPropertyNames(position)).toEqual([])
		expect(Object.getOwnPropertyNames(position.writer)).toEqual([])
		expect(JSON.stringify(position)).toBe('{}')
		const loose = position as unknown as Record<string, unknown>
		expect(loose.watermark).toBe(5)
		// Assigning to the accessor-only fields is refused (strict mode), and leaves the value.
		expect(() => {
			loose.watermark = 1
		}).toThrow(TypeError)
		expect(() => {
			loose.rulesKey = 'x'
		}).toThrow(TypeError)
		expect(position.watermark).toBe(5)
	})
})
