import { describe, expect, test } from 'vitest'
import { validateProjectName } from './project-name'

describe('validateProjectName', () => {
	test('accepts valid package names', () => {
		const result = validateProjectName('my-kora-app')
		expect(result.valid).toBe(true)
		expect(result.issues).toEqual([])
	})

	test('rejects empty names', () => {
		const result = validateProjectName('   ')
		expect(result.valid).toBe(false)
		expect(result.issues[0]).toContain('cannot be empty')
	})

	test('rejects names with invalid characters', () => {
		const result = validateProjectName('my app')
		expect(result.valid).toBe(false)
		expect(result.issues.length).toBeGreaterThan(0)
	})
})
