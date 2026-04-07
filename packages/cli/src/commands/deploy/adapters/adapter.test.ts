import { describe, expect, test } from 'vitest'
import { DEPLOY_PLATFORMS, isDeployPlatform } from './adapter'

describe('deploy adapter platform helpers', () => {
	test('accepts all supported deploy platforms', () => {
		for (const platform of DEPLOY_PLATFORMS) {
			expect(isDeployPlatform(platform)).toBe(true)
		}
	})

	test('rejects unknown platform values', () => {
		expect(isDeployPlatform('vercel')).toBe(false)
		expect(isDeployPlatform('')).toBe(false)
	})
})
