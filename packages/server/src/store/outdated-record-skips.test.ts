import { describe, expect, test } from 'vitest'
import { OutdatedRecordSkips } from './record-fold'

const row = (record_id: string) => ({ collection: 'docs', record_id })

describe('OutdatedRecordSkips', () => {
	test('records that failed are taken after the others, and retried when only they remain', () => {
		const skips = new OutdatedRecordSkips()
		skips.failed('docs', 'a')
		skips.failed('docs', 'b')
		expect(skips.readLimit(2)).toBe(4)
		expect(skips.choose([row('a'), row('b'), row('c')], 2)).toEqual([row('c')])
		// Only the failed ones are left: they are retried (and forgotten until they fail again).
		expect(skips.choose([row('a'), row('b')], 2)).toEqual([row('a'), row('b')])
		expect(skips.readLimit(2)).toBe(2)
	})
})
