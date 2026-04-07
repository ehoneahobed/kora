import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/fixtures/test-helpers'
import { bundleServer } from './server-bundler'

describe('bundleServer', () => {
	test('writes server-bundled.js when server entry exists', async () => {
		const tempDir = await createTempDir()
		try {
			await writeFile(join(tempDir.path, 'server.ts'), 'export {}', 'utf-8')
			const deployDir = join(tempDir.path, '.kora', 'deploy')
			const result = await bundleServer({
				projectRoot: tempDir.path,
				deployDirectory: deployDir,
			})

			expect(result.entryFilePath).toContain(join(tempDir.path, 'server.ts'))
			expect(result.outputFilePath).toContain(join(deployDir, 'server-bundled.js'))
		} finally {
			await tempDir.cleanup()
		}
	})

	test('throws when no server entry candidates exist', async () => {
		const tempDir = await createTempDir()
		try {
			const deployDir = join(tempDir.path, '.kora', 'deploy')
			await mkdir(deployDir, { recursive: true })
			await expect(
				bundleServer({
					projectRoot: tempDir.path,
					deployDirectory: deployDir,
				}),
			).rejects.toThrow('Could not find a server entry file')
		} finally {
			await tempDir.cleanup()
		}
	})
})
