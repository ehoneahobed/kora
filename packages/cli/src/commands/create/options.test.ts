import { describe, expect, test } from 'vitest'
import {
	determineTemplateFromSelections,
	isAuthValue,
	isDatabaseProviderValue,
	isDatabaseValue,
	isFrameworkValue,
	isPlatformValue,
} from './options'

describe('determineTemplateFromSelections', () => {
	test('returns sync tailwind template when enabled', () => {
		const template = determineTemplateFromSelections({
			platform: 'web',
			framework: 'react',
			tailwind: true,
			sync: true,
			db: 'sqlite',
		})
		expect(template).toBe('react-tailwind-sync')
	})

	test('returns local-only template when sync disabled', () => {
		const template = determineTemplateFromSelections({
			platform: 'web',
			framework: 'react',
			tailwind: false,
			sync: false,
			db: 'none',
		})
		expect(template).toBe('react-basic')
	})

	test('treats db none as local-only even if sync true', () => {
		const template = determineTemplateFromSelections({
			platform: 'web',
			framework: 'react',
			tailwind: false,
			sync: true,
			db: 'none',
		})
		expect(template).toBe('react-basic')
	})

	test('returns vue-sync for vue with sync enabled', () => {
		const template = determineTemplateFromSelections({
			platform: 'web',
			framework: 'vue',
			tailwind: false,
			sync: true,
			db: 'sqlite',
		})
		expect(template).toBe('vue-sync')
	})

	test('returns svelte-basic for svelte without sync', () => {
		const template = determineTemplateFromSelections({
			platform: 'web',
			framework: 'svelte',
			tailwind: false,
			sync: false,
			db: 'none',
		})
		expect(template).toBe('svelte-basic')
	})

	test('returns vue-tailwind-sync when tailwind and sync enabled', () => {
		const template = determineTemplateFromSelections({
			platform: 'web',
			framework: 'vue',
			tailwind: true,
			sync: true,
			db: 'sqlite',
		})
		expect(template).toBe('vue-tailwind-sync')
	})

	test('returns svelte-tailwind for svelte with tailwind only', () => {
		const template = determineTemplateFromSelections({
			platform: 'web',
			framework: 'svelte',
			tailwind: true,
			sync: false,
			db: 'none',
		})
		expect(template).toBe('svelte-tailwind')
	})

	test('returns tauri-react for desktop-tauri platform', () => {
		const template = determineTemplateFromSelections({
			platform: 'desktop-tauri',
			framework: 'react',
			tailwind: true,
			sync: true,
			db: 'sqlite',
		})
		expect(template).toBe('tauri-react')
	})

	test('tauri-react ignores tailwind and sync settings', () => {
		const template = determineTemplateFromSelections({
			platform: 'desktop-tauri',
			framework: 'react',
			tailwind: false,
			sync: false,
			db: 'none',
		})
		expect(template).toBe('tauri-react')
	})
})

describe('value guards', () => {
	test('platform guard accepts known values', () => {
		expect(isPlatformValue('web')).toBe(true)
		expect(isPlatformValue('desktop-tauri')).toBe(true)
		expect(isPlatformValue('mobile')).toBe(false)
	})

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
