import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SchemaWatcher } from './schema-watcher'

const { watchMock, spawnMock, resolveProjectBinaryMock } = vi.hoisted(() => {
	return {
		watchMock: vi.fn(),
		spawnMock: vi.fn(),
		resolveProjectBinaryMock: vi.fn(),
	}
})

vi.mock('node:fs', () => {
	return {
		watch: watchMock,
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

describe('SchemaWatcher', () => {
	let watchCallback: (() => void) | null
	let fakeFsWatcher: EventEmitter & { close: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		watchCallback = null
		fakeFsWatcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
		fakeFsWatcher.close = vi.fn()

		watchMock.mockReset()
		spawnMock.mockReset()
		resolveProjectBinaryMock.mockReset()

		watchMock.mockImplementation((_path: string, callback: () => void) => {
			watchCallback = callback
			return fakeFsWatcher
		})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test('start() watches schema path', () => {
		const watcher = new SchemaWatcher({
			schemaPath: '/project/src/schema.ts',
			projectRoot: '/project',
		})

		watcher.start()

		expect(watchMock).toHaveBeenCalledWith('/project/src/schema.ts', expect.any(Function))
	})

	test('file change triggers regenerate after debounce', async () => {
		vi.useFakeTimers()
		const watcher = new SchemaWatcher({
			schemaPath: '/project/src/schema.ts',
			projectRoot: '/project',
			debounceMs: 300,
		})
		const regenerateSpy = vi.spyOn(watcher, 'regenerate').mockResolvedValue()

		watcher.start()
		watchCallback?.()

		await vi.advanceTimersByTimeAsync(299)
		expect(regenerateSpy).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(regenerateSpy).toHaveBeenCalledTimes(1)
	})

	test('rapid changes are debounced to one regeneration', async () => {
		vi.useFakeTimers()
		const watcher = new SchemaWatcher({
			schemaPath: '/project/src/schema.ts',
			projectRoot: '/project',
			debounceMs: 300,
		})
		const regenerateSpy = vi.spyOn(watcher, 'regenerate').mockResolvedValue()

		watcher.start()
		watchCallback?.()
		watchCallback?.()
		watchCallback?.()

		await vi.advanceTimersByTimeAsync(300)
		expect(regenerateSpy).toHaveBeenCalledTimes(1)
	})

	test('stop() closes watcher and clears pending timer', async () => {
		vi.useFakeTimers()
		const watcher = new SchemaWatcher({
			schemaPath: '/project/src/schema.ts',
			projectRoot: '/project',
			debounceMs: 300,
		})
		const regenerateSpy = vi.spyOn(watcher, 'regenerate').mockResolvedValue()

		watcher.start()
		watchCallback?.()
		watcher.stop()

		await vi.advanceTimersByTimeAsync(1000)
		expect(fakeFsWatcher.close).toHaveBeenCalledTimes(1)
		expect(regenerateSpy).not.toHaveBeenCalled()
	})

	test('regenerate() uses tsx when available', async () => {
		resolveProjectBinaryMock.mockImplementation(async (_projectRoot: string, binaryName: string) => {
			if (binaryName === 'kora') return '/project/node_modules/.bin/kora'
			if (binaryName === 'tsx') return '/project/node_modules/.bin/tsx'
			return null
		})

		spawnMock.mockImplementation(() => {
			const child = createFakeChild()
			queueMicrotask(() => {
				child.emit('exit', 0, null)
			})
			return child
		})

		const watcher = new SchemaWatcher({
			schemaPath: '/project/src/schema.ts',
			projectRoot: '/project',
		})

		await watcher.regenerate()

		expect(spawnMock).toHaveBeenCalledWith(
			'/project/node_modules/.bin/tsx',
			['/project/node_modules/.bin/kora', 'generate', 'types'],
			expect.objectContaining({ cwd: '/project' }),
		)
	})

	test('regenerate() falls back to node when tsx is unavailable', async () => {
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

		resolveProjectBinaryMock.mockImplementation(async (_projectRoot: string, binaryName: string) => {
			if (binaryName === 'kora') return '/project/node_modules/.bin/kora'
			if (binaryName === 'tsx') return null
			return null
		})

		spawnMock.mockImplementation(() => {
			const child = createFakeChild()
			queueMicrotask(() => {
				child.emit('exit', 0, null)
			})
			return child
		})

		const watcher = new SchemaWatcher({
			schemaPath: '/project/src/schema.ts',
			projectRoot: '/project',
		})

		await watcher.regenerate()

		expect(spawnMock).toHaveBeenCalledWith(
			process.execPath,
			['/project/node_modules/.bin/kora', 'generate', 'types'],
			expect.objectContaining({ cwd: '/project' }),
		)
		expect(stderrSpy).toHaveBeenCalledWith(
			'[kora] Could not find "tsx" binary. Falling back to node.\n',
		)

		stderrSpy.mockRestore()
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
