import { t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { materializedFieldValue } from './record-fold'

describe('materializedFieldValue (RT-106)', () => {
	const status = t.string().default('open')._build()
	const due = t.timestamp().optional()._build()

	test('the fold value wins, including an explicit null', () => {
		expect(materializedFieldValue({ status: 'done' }, 'status', status)).toBe('done')
		expect(materializedFieldValue({ status: null }, 'status', status)).toBeNull()
	})

	test('a field the fold never wrote reads its schema default, or null', () => {
		expect(materializedFieldValue({ title: 'x' }, 'status', status)).toBe('open')
		expect(materializedFieldValue({ title: 'x' }, 'due', due)).toBeNull()
	})
})
