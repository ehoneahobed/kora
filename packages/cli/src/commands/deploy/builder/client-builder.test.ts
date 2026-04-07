import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildClient } from './client-builder'

const { spawnMock, resolveProjectBinaryEntryPointMock } = vi.hoisted(() => {
	return {
		spawnMock: vi.fn(),
		resolveProjectBinaryEntryPointMock: vi.fn(),
	}
})

vi.mock('node:child_process', () => {
	return {
		spawn: spawnMock,
	}
})

vi.mock('../../../utils/fs-helpers', () => {
	return {
		resolveProjectBinaryEntryPoint: resolveProjectBinaryEntryPointMock,
	}
})

describe('buildClient', () => {
	beforeEach(() => {
		spawnMock.mockReset()
		resolveProjectBinaryEntryPointMock.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	test('builds with local vite binary and returns output directory', async () => {
		resolveProjectBinaryEntryPointMock.mockResolvedValue('/app/node_modules/vite/bin/vite.js')
		const fakeChild = createFakeChild()
		spawnMock.mockReturnValue(fakeChild)
		const resultPromise = buildClient({
			projectRoot: '/app',
			outDir: '/app/.kora/deploy/dist',
			mode: 'production',
		})

		await Promise.resolve()
		fakeChild.emit('exit', 0)
		const result = await resultPromise
		expect(result.outDir).toBe('/app/.kora/deploy/dist')
		expect(spawnMock).toHaveBeenCalledWith(
			process.execPath,
			[
				'/app/node_modules/vite/bin/vite.js',
				'build',
				'--outDir',
				'/app/.kora/deploy/dist',
				'--mode',
				'production',
			],
			expect.objectContaining({
				cwd: '/app',
				stdio: 'inherit',
			}),
		)
	})

	test('throws when vite binary cannot be resolved', async () => {
		resolveProjectBinaryEntryPointMock.mockResolvedValue(null)

		await expect(
			buildClient({
				projectRoot: '/app',
				outDir: '/app/.kora/deploy/dist',
			}),
		).rejects.toThrow(/Could not find local Vite binary/)
		expect(spawnMock).not.toHaveBeenCalled()
	})

	test('throws when child process exits with non-zero code', async () => {
		resolveProjectBinaryEntryPointMock.mockResolvedValue('/app/node_modules/vite/bin/vite.js')
		const fakeChild = createFakeChild()
		spawnMock.mockReturnValue(fakeChild)

		const promise = buildClient({
			projectRoot: '/app',
			outDir: '/app/.kora/deploy/dist',
		})
		await Promise.resolve()
		fakeChild.emit('exit', 1)

		await expect(promise).rejects.toThrow(/Client build failed with exit code 1/)
	})
})

function createFakeChild(): EventEmitter & {
	on: (event: string, listener: (...args: unknown[]) => void) => EventEmitter
} {
	return new EventEmitter() as EventEmitter & {
		on: (event: string, listener: (...args: unknown[]) => void) => EventEmitter
	}
}
