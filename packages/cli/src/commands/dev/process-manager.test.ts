import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ProcessManager } from './process-manager'

const { spawnMock } = vi.hoisted(() => {
	return {
		spawnMock: vi.fn(),
	}
})

vi.mock('node:child_process', () => {
	return {
		spawn: spawnMock,
	}
})

describe('ProcessManager', () => {
	let stdoutWriteSpy: ReturnType<typeof vi.spyOn>
	let stderrWriteSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		spawnMock.mockReset()
		stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
	})

	afterEach(() => {
		stdoutWriteSpy.mockRestore()
		stderrWriteSpy.mockRestore()
		vi.useRealTimers()
	})

	test('spawns process with correct command and cwd', () => {
		const fakeChild = createFakeChild()
		spawnMock.mockReturnValue(fakeChild)
		const manager = new ProcessManager()

		manager.spawn({
			label: 'vite',
			command: '/project/node_modules/.bin/vite',
			args: ['--port', '5173'],
			cwd: '/project',
		})

		expect(spawnMock).toHaveBeenCalledWith(
			'/project/node_modules/.bin/vite',
			['--port', '5173'],
			expect.objectContaining({
				cwd: '/project',
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
		)
	})

	test('prefixes stdout and stderr output lines', () => {
		const fakeChild = createFakeChild()
		spawnMock.mockReturnValue(fakeChild)
		const manager = new ProcessManager()

		manager.spawn({
			label: 'sync',
			command: 'tsx',
			args: ['server.ts'],
			cwd: '/project',
		})

		fakeChild.stdout.write('started\n')
		fakeChild.stderr.write('warning\n')

		expect(stdoutWriteSpy).toHaveBeenCalledWith('[sync] started\n')
		expect(stderrWriteSpy).toHaveBeenCalledWith('[sync] warning\n')
	})

	test('splits multiline chunks and flushes trailing data on exit', () => {
		const fakeChild = createFakeChild()
		spawnMock.mockReturnValue(fakeChild)
		const manager = new ProcessManager()

		manager.spawn({
			label: 'vite',
			command: 'vite',
			args: [],
			cwd: '/project',
		})

		fakeChild.stdout.write('line-1\nline')
		fakeChild.stdout.write('-2\nline-3')
		fakeChild.emit('exit', 0, null)

		expect(stdoutWriteSpy).toHaveBeenCalledWith('[vite] line-1\n')
		expect(stdoutWriteSpy).toHaveBeenCalledWith('[vite] line-2\n')
		expect(stdoutWriteSpy).toHaveBeenCalledWith('[vite] line-3\n')
	})

	test('shutdownAll sends SIGTERM and resolves on exit', async () => {
		const fakeChild = createFakeChild()
		spawnMock.mockReturnValue(fakeChild)
		const manager = new ProcessManager()

		manager.spawn({
			label: 'vite',
			command: 'vite',
			args: [],
			cwd: '/project',
		})

		const shutdownPromise = manager.shutdownAll()
		expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')

		fakeChild.emit('exit', 0, null)
		await shutdownPromise
		expect(manager.hasRunning()).toBe(false)
	})

	test('shutdownAll sends SIGKILL after timeout for stragglers', async () => {
		vi.useFakeTimers()
		const fakeChild = createFakeChild()
		spawnMock.mockReturnValue(fakeChild)
		const manager = new ProcessManager()

		manager.spawn({
			label: 'vite',
			command: 'vite',
			args: [],
			cwd: '/project',
		})

		const shutdownPromise = manager.shutdownAll()
		expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')

		await vi.advanceTimersByTimeAsync(5000)
		expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL')

		fakeChild.emit('exit', null, 'SIGKILL')
		await shutdownPromise
	})
})

function createFakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough
		stderr: PassThrough
		kill: ReturnType<typeof vi.fn>
		killed: boolean
	}

	child.stdout = new PassThrough()
	child.stderr = new PassThrough()
	child.killed = false
	child.kill = vi.fn((signal?: NodeJS.Signals) => {
		if (signal === 'SIGTERM' || signal === 'SIGKILL') {
			child.killed = true
		}
		return true
	})

	return child
}
