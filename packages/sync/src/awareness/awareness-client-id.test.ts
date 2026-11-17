import { describe, expect, test, vi } from 'vitest'

/**
 * Each page (each fresh module) must pick its own awareness id. A counter starting at 1 gave
 * every page id 1, so pages dropped each other's presence as their own echo.
 */
async function firstIdOfAFreshPage(): Promise<number> {
	vi.resetModules()
	const { AwarenessManager } = await import('./awareness-manager')
	return new AwarenessManager().clientId
}

describe('awareness client ids', () => {
	test('two fresh pages pick different ids, in the positive 31-bit range', async () => {
		const ids = new Set<number>()
		for (let i = 0; i < 20; i++) ids.add(await firstIdOfAFreshPage())
		expect(ids.size).toBe(20)
		for (const id of ids) {
			expect(Number.isInteger(id)).toBe(true)
			expect(id).toBeGreaterThan(0)
			expect(id).toBeLessThanOrEqual(0x7fffffff)
		}
	})

	test('an explicit id is kept', async () => {
		const { AwarenessManager } = await import('./awareness-manager')
		expect(new AwarenessManager({ clientId: 42 }).clientId).toBe(42)
	})
})
