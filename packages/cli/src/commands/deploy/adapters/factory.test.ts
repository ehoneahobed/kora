import { describe, expect, test } from 'vitest'
import { createDeployAdapter } from './factory'

describe('createDeployAdapter', () => {
	test('returns FlyAdapter for fly platform', () => {
		const adapter = createDeployAdapter('fly')
		expect(adapter.name).toBe('fly')
	})

	test('returns RailwayAdapter for railway platform', () => {
		const adapter = createDeployAdapter('railway')
		expect(adapter.name).toBe('railway')
	})

	test('returns AwsEcsAdapter for aws-ecs platform', () => {
		const adapter = createDeployAdapter('aws-ecs')
		expect(adapter.name).toBe('aws-ecs')
	})

	test('returns AwsLightsailAdapter for aws-lightsail platform', () => {
		const adapter = createDeployAdapter('aws-lightsail')
		expect(adapter.name).toBe('aws-lightsail')
	})

	test('returns StubDeployAdapter for non-implemented platforms', async () => {
		const platforms = ['render', 'docker', 'kora-cloud'] as const
		for (const platform of platforms) {
			const adapter = createDeployAdapter(platform)
			expect(adapter.name).toBe(platform)
			expect(await adapter.detect()).toBe(false)
		}
	})
})
