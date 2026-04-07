import { describe, expect, test } from 'vitest'
import { createDeployAdapter } from './factory'

describe('createDeployAdapter', () => {
	test('returns FlyAdapter for fly platform', () => {
		const adapter = createDeployAdapter('fly')
		expect(adapter.name).toBe('fly')
	})

	test('returns StubDeployAdapter for remaining platforms', async () => {
		const platforms = ['railway', 'render', 'docker', 'kora-cloud'] as const
		for (const platform of platforms) {
			const adapter = createDeployAdapter(platform)
			expect(adapter.name).toBe(platform)
			expect(await adapter.detect()).toBe(false)
		}
	})
})
