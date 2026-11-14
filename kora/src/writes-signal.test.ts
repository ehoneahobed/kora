import { describe, expect, test } from 'vitest'
import { type WritesSignal, publishWritesSignal } from './writes-signal'

describe('publishWritesSignal', () => {
	test('reports the open store’s unsettled writes, and zero before a store opens', async () => {
		const target: { __KORA_WRITES__?: unknown } = {}
		let store: { pendingWriteCount(): number; whenWritesSettled(): Promise<void> } | null = null
		expect(publishWritesSignal(() => store, target)).toBe(true)
		const signal = target.__KORA_WRITES__ as WritesSignal
		expect(signal.v).toBe(1)
		expect(signal.pending()).toBe(0)
		await expect(signal.settled()).resolves.toBeUndefined()
		store = { pendingWriteCount: () => 2, whenWritesSettled: async () => undefined }
		expect(signal.pending()).toBe(2)
	})

	test('a second app on the page leaves the first app’s signal alone', () => {
		const target: { __KORA_WRITES__?: unknown } = {}
		publishWritesSignal(() => null, target)
		const first = target.__KORA_WRITES__
		expect(publishWritesSignal(() => null, target)).toBe(false)
		expect(target.__KORA_WRITES__).toBe(first)
	})
})
