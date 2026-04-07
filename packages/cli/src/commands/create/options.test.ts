import { describe, expect, test } from 'vitest'
import {
	determineTemplateFromSelections,
	isAuthValue,
	isDatabaseProviderValue,
	isDatabaseValue,
	isFrameworkValue,
} from './options'

describe('determineTemplateFromSelections', () => {
	test('returns sync tailwind template when enabled', () => {
		const template = determineTemplateFromSelections({
			tailwind: true,
			sync: true,
			db: 'sqlite',
		})
		expect(template).toBe('react-tailwind-sync')
	})

	test('returns local-only template when sync disabled', () => {
		const template = determineTemplateFromSelections({
			tailwind: false,
			sync: false,
			db: 'none',
		})
		expect(template).toBe('react-basic')
	})

	test('treats db none as local-only even if sync true', () => {
		const template = determineTemplateFromSelections({
			tailwind: false,
			sync: true,
			db: 'none',
		})
		expect(template).toBe('react-basic')
	})
})

describe('value guards', () => {
	test('framework guard accepts known values', () => {
		expect(isFrameworkValue('react')).toBe(true)
		expect(isFrameworkValue('vue')).toBe(true)
		expect(isFrameworkValue('invalid')).toBe(false)
	})

	test('auth guard accepts known values', () => {
		expect(isAuthValue('none')).toBe(true)
		expect(isAuthValue('oauth')).toBe(true)
		expect(isAuthValue('saml')).toBe(false)
	})

	test('database guard accepts known values', () => {
		expect(isDatabaseValue('none')).toBe(true)
		expect(isDatabaseValue('sqlite')).toBe(true)
		expect(isDatabaseValue('mysql')).toBe(false)
	})

	test('database provider guard accepts known values', () => {
		expect(isDatabaseProviderValue('local')).toBe(true)
		expect(isDatabaseProviderValue('vercel-postgres')).toBe(true)
		expect(isDatabaseProviderValue('render')).toBe(false)
	})
})
