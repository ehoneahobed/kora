import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { loadKoraConfig } from './kora-config'

const { spawnMock, resolveProjectBinaryMock } = vi.hoisted(() => {
	return {
		spawnMock: vi.fn(),
		resolveProjectBinaryMock: vi.fn(),
	}
})

vi.mock('node:child_process', () => {
	return {
		spawn: spawnMock,
	}
})

vi.mock('../../utils/fs-helpers', () => {
	return {
		resolveProjectBinary: resolveProjectBinaryMock,
	}
})

describe('loadKoraConfig', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
		spawnMock.mockReset()
		resolveProjectBinaryMock.mockReset()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('returns null when no config exists', async () => {
		const result = await loadKoraConfig(tempDir.path)
		expect(result).toBeNull()
	})

	test('loads JavaScript config file', async () => {
		await writeFile(
			join(tempDir.path, 'kora.config.mjs'),
			"export default { schema: './src/schema.ts', dev: { port: 4111 } }",
		)

		const result = await loadKoraConfig(tempDir.path)
		expect(result).toEqual({ schema: './src/schema.ts', dev: { port: 4111 } })
	})

	test('throws for TypeScript config when tsx is missing', async () => {
		await writeFile(join(tempDir.path, 'kora.config.ts'), 'export default { dev: { port: 4000 } }')
		resolveProjectBinaryMock.mockResolvedValue(null)

		await expect(loadKoraConfig(tempDir.path)).rejects.toThrow('tsx')
	})

	test('loads TypeScript config via tsx process', async () => {
		await writeFile(join(tempDir.path, 'kora.config.ts'), 'export default { dev: { port: 4000 } }')
		resolveProjectBinaryMock.mockResolvedValue('/project/node_modules/.bin/tsx')

		spawnMock.mockImplementation(() => {
			const child = createFakeChild()
			queueMicrotask(() => {
				child.stdout.write('{"dev":{"port":4000}}')
				child.emit('exit', 0, null)
			})
			return child
		})

		const result = await loadKoraConfig(tempDir.path)
		expect(result).toEqual({ dev: { port: 4000 } })
	})
})

function createFakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough
		stderr: PassThrough
	}

	child.stdout = new PassThrough()
	child.stderr = new PassThrough()

	return child
}
