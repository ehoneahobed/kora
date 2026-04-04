import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	detectPackageManager,
	getInstallCommand,
	getRunDevCommand,
	isPackageManagerAvailable,
} from './package-manager'

describe('detectPackageManager', () => {
	const originalEnv = process.env['npm_config_user_agent']

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env['npm_config_user_agent']
		} else {
			process.env['npm_config_user_agent'] = originalEnv
		}
	})

	test('detects pnpm from user agent', () => {
		process.env['npm_config_user_agent'] = 'pnpm/9.15.4 node/v20.0.0'
		expect(detectPackageManager()).toBe('pnpm')
	})

	test('detects yarn from user agent', () => {
		process.env['npm_config_user_agent'] = 'yarn/4.0.0 node/v20.0.0'
		expect(detectPackageManager()).toBe('yarn')
	})

	test('detects bun from user agent', () => {
		process.env['npm_config_user_agent'] = 'bun/1.0.0 node/v20.0.0'
		expect(detectPackageManager()).toBe('bun')
	})

	test('detects npm from user agent', () => {
		process.env['npm_config_user_agent'] = 'npm/10.0.0 node/v20.0.0'
		expect(detectPackageManager()).toBe('npm')
	})

	test('falls back to npm when no user agent', () => {
		delete process.env['npm_config_user_agent']
		expect(detectPackageManager()).toBe('npm')
	})
})

describe('getInstallCommand', () => {
	test('returns pnpm install', () => {
		expect(getInstallCommand('pnpm')).toBe('pnpm install')
	})

	test('returns npm install', () => {
		expect(getInstallCommand('npm')).toBe('npm install')
	})

	test('returns yarn (no install keyword)', () => {
		expect(getInstallCommand('yarn')).toBe('yarn')
	})

	test('returns bun install', () => {
		expect(getInstallCommand('bun')).toBe('bun install')
	})
})

describe('getRunDevCommand', () => {
	test('returns npm run dev for npm', () => {
		expect(getRunDevCommand('npm')).toBe('npm run dev')
	})

	test('returns pnpm dev for pnpm', () => {
		expect(getRunDevCommand('pnpm')).toBe('pnpm dev')
	})

	test('returns yarn dev for yarn', () => {
		expect(getRunDevCommand('yarn')).toBe('yarn dev')
	})

	test('returns bun dev for bun', () => {
		expect(getRunDevCommand('bun')).toBe('bun dev')
	})
})

describe('isPackageManagerAvailable', () => {
	test('returns true for an available package manager', () => {
		// node is always available in test environment, npm should be too
		expect(isPackageManagerAvailable('npm')).toBe(true)
	})
})
