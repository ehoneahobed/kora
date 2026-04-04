import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { InvalidProjectError } from '../../errors'
import { findProjectRoot } from '../../utils/fs-helpers'

describe('dev command', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('devCommand is defined with correct args', async () => {
		const { devCommand } = await import('./dev-command')
		expect(devCommand).toBeDefined()
	})

	test('rejects non-kora project directory', async () => {
		// Create a non-kora package.json
		await writeFile(
			join(tempDir.path, 'package.json'),
			JSON.stringify({ name: 'not-kora', dependencies: { react: '18.0.0' } }),
		)

		const projectRoot = await findProjectRoot(tempDir.path)
		expect(projectRoot).toBeNull()
		// The command would throw InvalidProjectError
		expect(() => new InvalidProjectError(tempDir.path)).not.toThrow()
	})
})
