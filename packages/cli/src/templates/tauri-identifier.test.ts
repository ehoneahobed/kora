import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { tauriIdentifierFor } from './tauri-identifier'

const VALID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/

describe('tauriIdentifierFor', () => {
	test('examples', () => {
		expect(tauriIdentifierFor('my-notes')).toBe('com.my-notes')
		expect(tauriIdentifierFor('@acme/Field Notes')).toBe('com.field-notes')
		expect(tauriIdentifierFor('2048')).toBe('com.app-2048')
		expect(tauriIdentifierFor('---')).toBe('com.desktop')
		expect(tauriIdentifierFor('App')).toBe('com.app-desktop')
	})

	test('property: any name gives a valid identifier that never ends in .app', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), (name) => {
				const id = tauriIdentifierFor(name)
				expect(id).toMatch(VALID)
				expect(id.endsWith('.app')).toBe(false)
			}),
			{ numRuns: 500 },
		)
	})
})
