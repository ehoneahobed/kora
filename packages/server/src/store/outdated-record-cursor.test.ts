import { describe, expect, test } from 'vitest'
import { OutdatedRecordCursor } from './record-fold'

const row = (record_id: string) => ({ collection: 'docs', record_id })

describe('OutdatedRecordCursor', () => {
	test('a full batch moves on past its last record; a short one wraps around', () => {
		const cursor = new OutdatedRecordCursor()
		expect(cursor.position()).toBeNull()
		cursor.advance([row('a'), row('b')], 2)
		expect(cursor.position()).toEqual({ collection: 'docs', recordId: 'b' })
		cursor.advance([row('c')], 2)
		expect(cursor.position()).toBeNull()
	})
})
