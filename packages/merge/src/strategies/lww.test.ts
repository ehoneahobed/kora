import type { HLCTimestamp } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { lastWriteWins } from './lww'

describe('lastWriteWins', () => {
	test('local wins when local wallTime is later', () => {
		const localTs: HLCTimestamp = { wallTime: 2000, logical: 0, nodeId: 'node-a' }
		const remoteTs: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'node-b' }

		const result = lastWriteWins('local-val', 'remote-val', localTs, remoteTs)

		expect(result.value).toBe('local-val')
		expect(result.winner).toBe('local')
	})

	test('remote wins when remote wallTime is later', () => {
		const localTs: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'node-a' }
		const remoteTs: HLCTimestamp = { wallTime: 2000, logical: 0, nodeId: 'node-b' }

		const result = lastWriteWins('local-val', 'remote-val', localTs, remoteTs)

		expect(result.value).toBe('remote-val')
		expect(result.winner).toBe('remote')
	})

	test('higher logical counter wins when wallTime is equal', () => {
		const localTs: HLCTimestamp = { wallTime: 1000, logical: 5, nodeId: 'node-a' }
		const remoteTs: HLCTimestamp = { wallTime: 1000, logical: 3, nodeId: 'node-b' }

		const result = lastWriteWins('local-val', 'remote-val', localTs, remoteTs)

		expect(result.value).toBe('local-val')
		expect(result.winner).toBe('local')
	})

	test('remote wins with higher logical counter when wallTime equal', () => {
		const localTs: HLCTimestamp = { wallTime: 1000, logical: 1, nodeId: 'node-a' }
		const remoteTs: HLCTimestamp = { wallTime: 1000, logical: 5, nodeId: 'node-b' }

		const result = lastWriteWins('local-val', 'remote-val', localTs, remoteTs)

		expect(result.value).toBe('remote-val')
		expect(result.winner).toBe('remote')
	})

	test('nodeId tiebreaker when wallTime and logical are equal', () => {
		const localTs: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'node-b' }
		const remoteTs: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'node-a' }

		// node-b > node-a lexicographically, so local wins
		const result = lastWriteWins('local-val', 'remote-val', localTs, remoteTs)

		expect(result.value).toBe('local-val')
		expect(result.winner).toBe('local')
	})

	test('remote wins nodeId tiebreaker when remote nodeId is greater', () => {
		const localTs: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'node-a' }
		const remoteTs: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'node-b' }

		// node-a < node-b, so local comparison is negative → remote wins
		const result = lastWriteWins('local-val', 'remote-val', localTs, remoteTs)

		expect(result.value).toBe('remote-val')
		expect(result.winner).toBe('remote')
	})

	test('works with non-string values', () => {
		const localTs: HLCTimestamp = { wallTime: 2000, logical: 0, nodeId: 'a' }
		const remoteTs: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'b' }

		expect(lastWriteWins(42, 99, localTs, remoteTs).value).toBe(42)
		expect(lastWriteWins(true, false, localTs, remoteTs).value).toBe(true)
		expect(lastWriteWins(null, 'hello', localTs, remoteTs).value).toBe(null)
	})

	test('works with object values', () => {
		const localTs: HLCTimestamp = { wallTime: 2000, logical: 0, nodeId: 'a' }
		const remoteTs: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'b' }
		const localObj = { nested: true }
		const remoteObj = { nested: false }

		const result = lastWriteWins(localObj, remoteObj, localTs, remoteTs)

		expect(result.value).toBe(localObj)
		expect(result.winner).toBe('local')
	})
})
