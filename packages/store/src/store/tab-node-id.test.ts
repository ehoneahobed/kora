import { describe, expect, test, vi } from 'vitest'
import { loadPerTabNodeId, resolvePerTabNodeId, savePerTabNodeId } from './tab-node-id'

describe('tab-node-id', () => {
	test('resolvePerTabNodeId persists in sessionStorage', () => {
		const storage = new Map<string, string>()
		vi.stubGlobal('sessionStorage', {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storage.set(key, value)
			},
		})

		const first = resolvePerTabNodeId('app-db')
		const second = resolvePerTabNodeId('app-db')
		expect(second).toBe(first)
		expect(loadPerTabNodeId('app-db')).toBe(first)

		savePerTabNodeId('other-db', 'custom-node')
		expect(loadPerTabNodeId('other-db')).toBe('custom-node')
	})
})
