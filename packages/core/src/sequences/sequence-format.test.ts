import { describe, expect, test } from 'vitest'
import { defaultSequenceFormat, formatSequenceValue } from './sequence-format'

describe('formatSequenceValue', () => {
	const fixedDate = new Date('2026-05-08T12:00:00Z')
	const nodeId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

	test('replaces {date} with YYYYMMDD', () => {
		expect(formatSequenceValue('{date}', 1, nodeId, fixedDate)).toBe('20260508')
	})

	test('replaces {node4} with first 4 chars of nodeId', () => {
		expect(formatSequenceValue('{node4}', 1, nodeId)).toBe('a1b2')
	})

	test('replaces {node8} with first 8 chars of nodeId', () => {
		expect(formatSequenceValue('{node8}', 1, nodeId)).toBe('a1b2c3d4')
	})

	test('replaces {seq} with 4-digit padded counter', () => {
		expect(formatSequenceValue('{seq}', 42, nodeId)).toBe('0042')
	})

	test('replaces {seq:N} with N-digit padded counter', () => {
		expect(formatSequenceValue('{seq:6}', 7, nodeId)).toBe('000007')
	})

	test('handles counter larger than padding width', () => {
		expect(formatSequenceValue('{seq:2}', 12345, nodeId)).toBe('12345')
	})

	test('handles {seq:1}', () => {
		expect(formatSequenceValue('{seq:1}', 5, nodeId)).toBe('5')
	})

	test('handles invalid seq width (falls back to 4)', () => {
		expect(formatSequenceValue('{seq:abc}', 7, nodeId)).toBe('0007')
	})

	test('handles negative seq width (falls back to 4)', () => {
		expect(formatSequenceValue('{seq:-1}', 7, nodeId)).toBe('0007')
	})

	test('formats full receipt-style template', () => {
		const result = formatSequenceValue('S-{date}-{node4}-{seq}', 42, nodeId, fixedDate)
		expect(result).toBe('S-20260508-a1b2-0042')
	})

	test('formats invoice-style template', () => {
		const result = formatSequenceValue('INV-{date}-{seq:6}', 123, nodeId, fixedDate)
		expect(result).toBe('INV-20260508-000123')
	})

	test('formats order-style template', () => {
		const result = formatSequenceValue('ORDER-{seq:6}', 7, nodeId)
		expect(result).toBe('ORDER-000007')
	})

	test('preserves unknown tokens as-is', () => {
		expect(formatSequenceValue('{unknown}', 1, nodeId)).toBe('{unknown}')
	})

	test('handles template with no tokens', () => {
		expect(formatSequenceValue('FIXED-PREFIX', 1, nodeId)).toBe('FIXED-PREFIX')
	})

	test('handles empty template', () => {
		expect(formatSequenceValue('', 1, nodeId)).toBe('')
	})

	test('handles multiple occurrences of same token', () => {
		expect(formatSequenceValue('{seq}-{seq}', 5, nodeId)).toBe('0005-0005')
	})

	test('handles date at year boundary', () => {
		const dec31 = new Date('2025-12-31T23:59:59Z')
		expect(formatSequenceValue('{date}', 1, nodeId, dec31)).toBe('20251231')
	})

	test('handles single-digit month and day', () => {
		const jan1 = new Date('2026-01-01T00:00:00Z')
		expect(formatSequenceValue('{date}', 1, nodeId, jan1)).toBe('20260101')
	})
})

describe('defaultSequenceFormat', () => {
	test('produces name-{seq:4} format', () => {
		expect(defaultSequenceFormat('receipt')).toBe('receipt-{seq:4}')
	})

	test('works with different names', () => {
		expect(defaultSequenceFormat('order')).toBe('order-{seq:4}')
	})
})
