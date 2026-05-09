import type { HLCTimestamp } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	appendOnlyMerge,
	applySchemaStrategy,
	counterMerge,
	maxMerge,
	minMerge,
	serverAuthoritativeMerge,
} from './schema-strategies'

describe('counterMerge', () => {
	test('sums deltas from base', () => {
		// base=10, local=15 (+5), remote=12 (+2) → 10 + 5 + 2 = 17
		expect(counterMerge(15, 12, 10)).toBe(17)
	})

	test('handles negative deltas', () => {
		// base=100, local=95 (-5), remote=90 (-10) → 100 + (-5) + (-10) = 85
		expect(counterMerge(95, 90, 100)).toBe(85)
	})

	test('handles mixed positive and negative deltas', () => {
		// base=50, local=60 (+10), remote=45 (-5) → 50 + 10 + (-5) = 55
		expect(counterMerge(60, 45, 50)).toBe(55)
	})

	test('handles zero deltas', () => {
		expect(counterMerge(10, 10, 10)).toBe(10)
	})

	test('handles zero base', () => {
		// base=0, local=5, remote=3 → 0 + 5 + 3 = 8
		expect(counterMerge(5, 3, 0)).toBe(8)
	})

	test('treats non-number base as 0', () => {
		// base=undefined → 0, local=5, remote=3 → 0 + 5 + 3 = 8
		expect(counterMerge(5, 3, undefined)).toBe(8)
	})

	test('treats non-number local as base', () => {
		// local=undefined → treated as base (10), so localDelta=0
		// base=10, remote=15 → 10 + 0 + 5 = 15
		expect(counterMerge(undefined, 15, 10)).toBe(15)
	})

	test('treats non-number remote as base', () => {
		// remote=undefined → treated as base (10), so remoteDelta=0
		// base=10, local=15 → 10 + 5 + 0 = 15
		expect(counterMerge(15, undefined, 10)).toBe(15)
	})

	test('is commutative', () => {
		const resultAB = counterMerge(15, 12, 10)
		const resultBA = counterMerge(12, 15, 10)
		expect(resultAB).toBe(resultBA)
	})

	test('handles large numbers', () => {
		const base = 1_000_000
		const local = 1_000_500
		const remote = 1_000_300
		expect(counterMerge(local, remote, base)).toBe(1_000_800)
	})

	test('handles floating point deltas', () => {
		expect(counterMerge(10.5, 10.3, 10)).toBeCloseTo(10.8)
	})
})

describe('maxMerge', () => {
	test('returns the maximum of all values', () => {
		expect(maxMerge(15, 12, 10)).toBe(15)
	})

	test('returns remote when remote is max', () => {
		expect(maxMerge(12, 20, 10)).toBe(20)
	})

	test('returns base when base is max', () => {
		expect(maxMerge(5, 3, 10)).toBe(10)
	})

	test('handles equal values', () => {
		expect(maxMerge(10, 10, 10)).toBe(10)
	})

	test('handles negative numbers', () => {
		expect(maxMerge(-5, -3, -10)).toBe(-3)
	})

	test('ignores non-number values', () => {
		expect(maxMerge(undefined, 5, 10)).toBe(10)
	})

	test('returns baseValue when all non-number', () => {
		expect(maxMerge('a', 'b', 'c')).toBe('c')
	})

	test('is commutative', () => {
		expect(maxMerge(15, 20, 10)).toBe(maxMerge(20, 15, 10))
	})
})

describe('minMerge', () => {
	test('returns the minimum of all values', () => {
		expect(minMerge(15, 12, 10)).toBe(10)
	})

	test('returns local when local is min', () => {
		expect(minMerge(3, 12, 10)).toBe(3)
	})

	test('returns remote when remote is min', () => {
		expect(minMerge(12, 3, 10)).toBe(3)
	})

	test('handles equal values', () => {
		expect(minMerge(10, 10, 10)).toBe(10)
	})

	test('handles negative numbers', () => {
		expect(minMerge(-5, -3, -10)).toBe(-10)
	})

	test('ignores non-number values', () => {
		expect(minMerge(undefined, 5, 10)).toBe(5)
	})

	test('is commutative', () => {
		expect(minMerge(3, 12, 10)).toBe(minMerge(12, 3, 10))
	})
})

describe('appendOnlyMerge', () => {
	test('concatenates additions from both sides', () => {
		const base = ['a', 'b']
		const local = ['a', 'b', 'c']
		const remote = ['a', 'b', 'd']
		const result = appendOnlyMerge(local, remote, base) as string[]
		expect(result).toEqual(['a', 'b', 'c', 'd'])
	})

	test('preserves base items even if one side removed them', () => {
		const base = ['a', 'b', 'c']
		const local = ['a', 'c'] // removed 'b'
		const remote = ['a', 'b', 'c', 'd'] // added 'd'
		const result = appendOnlyMerge(local, remote, base) as string[]
		// append-only: removals are ignored, so base is preserved
		// only additions are appended
		expect(result).toEqual(['a', 'b', 'c', 'd'])
	})

	test('deduplicates additions', () => {
		const base = ['a']
		const local = ['a', 'b']
		const remote = ['a', 'b']
		const result = appendOnlyMerge(local, remote, base) as string[]
		expect(result).toEqual(['a', 'b'])
	})

	test('handles empty base', () => {
		const result = appendOnlyMerge(['a', 'b'], ['c', 'd'], []) as string[]
		expect(result).toEqual(['a', 'b', 'c', 'd'])
	})

	test('handles non-array inputs', () => {
		const result = appendOnlyMerge(undefined, undefined, undefined) as unknown[]
		expect(result).toEqual([])
	})

	test('works with objects (JSON serialization for dedup)', () => {
		const base = [{ id: 1 }]
		const local = [{ id: 1 }, { id: 2 }]
		const remote = [{ id: 1 }, { id: 3 }]
		const result = appendOnlyMerge(local, remote, base) as Array<{ id: number }>
		expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
	})

	test('is commutative (same set of items regardless of order)', () => {
		const base = ['a']
		const resultAB = appendOnlyMerge(['a', 'b'], ['a', 'c'], base) as string[]
		const resultBA = appendOnlyMerge(['a', 'c'], ['a', 'b'], base) as string[]
		// Order may differ (local additions first), but same elements
		expect(new Set(resultAB)).toEqual(new Set(resultBA))
	})
})

describe('serverAuthoritativeMerge', () => {
	test('always returns remote value', () => {
		expect(serverAuthoritativeMerge('local', 'remote', 'base')).toBe('remote')
	})

	test('returns remote even when local matches base', () => {
		expect(serverAuthoritativeMerge('base', 'remote', 'base')).toBe('remote')
	})

	test('returns remote even when remote matches base', () => {
		expect(serverAuthoritativeMerge('local', 'base', 'base')).toBe('base')
	})

	test('works with numbers', () => {
		expect(serverAuthoritativeMerge(100, 200, 50)).toBe(200)
	})

	test('works with null', () => {
		expect(serverAuthoritativeMerge('local', null, 'base')).toBe(null)
	})
})

describe('applySchemaStrategy', () => {
	const localTs: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'a' }
	const remoteTs: HLCTimestamp = { wallTime: 1001, logical: 0, nodeId: 'b' }

	test('dispatches counter strategy', () => {
		const result = applySchemaStrategy('counter', 15, 12, 10, localTs, remoteTs)
		expect(result).not.toBeNull()
		expect(result?.value).toBe(17)
		expect(result?.strategyName).toBe('schema-counter')
	})

	test('dispatches max strategy', () => {
		const result = applySchemaStrategy('max', 15, 20, 10, localTs, remoteTs)
		expect(result).not.toBeNull()
		expect(result?.value).toBe(20)
		expect(result?.strategyName).toBe('schema-max')
	})

	test('dispatches min strategy', () => {
		const result = applySchemaStrategy('min', 15, 12, 10, localTs, remoteTs)
		expect(result).not.toBeNull()
		expect(result?.value).toBe(10)
		expect(result?.strategyName).toBe('schema-min')
	})

	test('dispatches append-only strategy', () => {
		const result = applySchemaStrategy(
			'append-only',
			['a', 'b'],
			['a', 'c'],
			['a'],
			localTs,
			remoteTs,
		)
		expect(result).not.toBeNull()
		expect(result?.value).toEqual(['a', 'b', 'c'])
		expect(result?.strategyName).toBe('schema-append-only')
	})

	test('dispatches server-authoritative strategy', () => {
		const result = applySchemaStrategy(
			'server-authoritative',
			'local',
			'remote',
			'base',
			localTs,
			remoteTs,
		)
		expect(result).not.toBeNull()
		expect(result?.value).toBe('remote')
		expect(result?.strategyName).toBe('schema-server-authoritative')
	})

	test('returns null for lww (falls through to autoMerge)', () => {
		const result = applySchemaStrategy('lww', 'a', 'b', 'c', localTs, remoteTs)
		expect(result).toBeNull()
	})

	test('returns null for union (falls through to autoMerge)', () => {
		const result = applySchemaStrategy('union', ['a'], ['b'], [], localTs, remoteTs)
		expect(result).toBeNull()
	})
})
