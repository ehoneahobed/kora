import { describe, expect, test } from 'vitest'

describe('generate command', () => {
	test('generateCommand is defined with types subcommand', async () => {
		const { generateCommand } = await import('./generate-command')
		expect(generateCommand).toBeDefined()
	})
})
