import { describe, expect, it } from 'vitest'
import { UpgradeError } from '../errors'
import { compareVersions, isPrerelease, normalizeVersion, parseVersion } from './semver'

describe('parseVersion', () => {
	it('parses releases and prereleases', () => {
		expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
		expect(parseVersion('1.0.0-beta.14')?.prerelease).toEqual(['beta', '14'])
	})

	it('rejects ranges and garbage', () => {
		expect(parseVersion('^1.0.0')).toBeNull()
		expect(parseVersion('latest')).toBeNull()
		expect(parseVersion('1.0')).toBeNull()
	})
})

describe('normalizeVersion', () => {
	it('strips a v prefix and build metadata', () => {
		expect(normalizeVersion('v1.0.0-beta.15+abc')).toBe('1.0.0-beta.15')
		expect(normalizeVersion('nope')).toBeNull()
	})
})

describe('isPrerelease', () => {
	it('is true only with a prerelease tag', () => {
		expect(isPrerelease('1.0.0-beta.1')).toBe(true)
		expect(isPrerelease('1.0.0')).toBe(false)
	})
})

describe('compareVersions', () => {
	it('orders prereleases numerically, not lexically', () => {
		expect(compareVersions('1.0.0-beta.9', '1.0.0-beta.10')).toBeLessThan(0)
		expect(compareVersions('1.0.0-beta.15', '1.0.0-beta.14')).toBeGreaterThan(0)
	})

	it('puts a release above its prereleases and canaries by name', () => {
		expect(compareVersions('1.0.0', '1.0.0-beta.99')).toBeGreaterThan(0)
		expect(compareVersions('1.0.0-beta.1', '1.0.0-canary.1')).toBeLessThan(0)
		expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0)
	})

	it('compares major, minor and patch first and returns zero for equal versions', () => {
		expect(compareVersions('2.0.0-beta.1', '1.9.9')).toBeGreaterThan(0)
		expect(compareVersions('1.0.0-beta.14', '1.0.0-beta.14')).toBe(0)
	})

	it('throws on a non-exact version instead of guessing', () => {
		expect(() => compareVersions('^1.0.0', '1.0.0')).toThrow(UpgradeError)
	})
})
