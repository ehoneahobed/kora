import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { DevServerError, InvalidProjectError } from '../../errors'

const {
	findProjectRootMock,
	findSchemaFileMock,
	resolveProjectBinaryMock,
	createLoggerMock,
	loadKoraConfigMock,
	processManagerCtorMock,
	processManagerSpawnMock,
	processManagerHasRunningMock,
	processManagerShutdownAllMock,
	schemaWatcherCtorMock,
	schemaWatcherStartMock,
	schemaWatcherStopMock,
} = vi.hoisted(() => {
	const processManagerSpawn = vi.fn()
	const processManagerHasRunning = vi.fn(() => false)
	const processManagerShutdownAll = vi.fn(async () => {})

	const logger = {
		banner: vi.fn(),
		info: vi.fn(),
		step: vi.fn(),
		blank: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	}

	return {
		findProjectRootMock: vi.fn(),
		findSchemaFileMock: vi.fn(),
		resolveProjectBinaryMock: vi.fn(),
		createLoggerMock: vi.fn(() => logger),
		loadKoraConfigMock: vi.fn(),
		processManagerCtorMock: vi.fn(() => ({
			spawn: processManagerSpawn,
			hasRunning: processManagerHasRunning,
			shutdownAll: processManagerShutdownAll,
		})),
		processManagerSpawnMock: processManagerSpawn,
		processManagerHasRunningMock: processManagerHasRunning,
		processManagerShutdownAllMock: processManagerShutdownAll,
		schemaWatcherCtorMock: vi.fn(() => ({
			start: vi.fn(),
			stop: vi.fn(),
		})),
		schemaWatcherStartMock: vi.fn(),
		schemaWatcherStopMock: vi.fn(),
	}
})

vi.mock('../../utils/fs-helpers', () => {
	return {
		findProjectRoot: findProjectRootMock,
		findSchemaFile: findSchemaFileMock,
		resolveProjectBinary: resolveProjectBinaryMock,
	}
})

vi.mock('../../utils/logger', () => {
	return {
		createLogger: createLoggerMock,
	}
})

vi.mock('./kora-config', () => {
	return {
		loadKoraConfig: loadKoraConfigMock,
	}
})

vi.mock('./process-manager', () => {
	return {
		ProcessManager: processManagerCtorMock,
	}
})

vi.mock('./schema-watcher', () => {
	return {
		SchemaWatcher: vi.fn((config) => {
			schemaWatcherCtorMock(config)
			return {
				start: schemaWatcherStartMock,
				stop: schemaWatcherStopMock,
			}
		}),
	}
})

describe('dev command', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()

		findProjectRootMock.mockReset()
		findSchemaFileMock.mockReset()
		resolveProjectBinaryMock.mockReset()
		processManagerCtorMock.mockClear()
		loadKoraConfigMock.mockReset()
		processManagerSpawnMock.mockReset()
		processManagerHasRunningMock.mockReset()
		processManagerShutdownAllMock.mockReset()
		schemaWatcherCtorMock.mockReset()
		schemaWatcherStartMock.mockReset()
		schemaWatcherStopMock.mockReset()

		processManagerHasRunningMock.mockReturnValue(false)
		loadKoraConfigMock.mockResolvedValue(null)
		processManagerShutdownAllMock.mockResolvedValue(undefined)
		processManagerSpawnMock.mockImplementation((config: { onExit?: () => void }) => {
			config.onExit?.()
		})
		resolveProjectBinaryMock.mockImplementation(async (_projectRoot: string, binaryName: string) => {
			if (binaryName === 'vite') return '/project/node_modules/.bin/vite'
			if (binaryName === 'tsx') return '/project/node_modules/.bin/tsx'
			return null
		})
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('devCommand is defined with expected args', async () => {
		const { devCommand } = await import('./dev-command')
		expect(devCommand).toBeDefined()
		expect(devCommand.args).toHaveProperty('port')
		expect(devCommand.args).toHaveProperty('sync-port')
		expect(devCommand.args).toHaveProperty('no-sync')
		expect(devCommand.args).toHaveProperty('no-watch')
	})

	test('throws InvalidProjectError when not in kora project', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue(null)

		await expect(devCommand.run({ args: defaultArgs() })).rejects.toBeInstanceOf(InvalidProjectError)
	})

	test('throws DevServerError when vite binary is missing', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue('/project')
		resolveProjectBinaryMock.mockResolvedValue(null)

		await expect(devCommand.run({ args: defaultArgs() })).rejects.toBeInstanceOf(DevServerError)
	})

	test('detects sync when server.ts exists', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue(tempDir.path)
		findSchemaFileMock.mockResolvedValue(null)
		await writeFile(join(tempDir.path, 'server.ts'), 'console.log("sync")')

		await devCommand.run({ args: defaultArgs() })

		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'vite' }),
		)
		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'sync', args: [join(tempDir.path, 'server.ts')] }),
		)
	})

	test('--no-sync skips sync server process', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue(tempDir.path)
		findSchemaFileMock.mockResolvedValue(null)
		await writeFile(join(tempDir.path, 'server.ts'), 'console.log("sync")')

		await devCommand.run({ args: { ...defaultArgs(), 'no-sync': true } })

		expect(processManagerSpawnMock).toHaveBeenCalledTimes(1)
		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'vite' }),
		)
	})

	test('--no-watch skips schema watcher startup', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue(tempDir.path)
		findSchemaFileMock.mockResolvedValue(join(tempDir.path, 'src', 'schema.ts'))

		await devCommand.run({ args: { ...defaultArgs(), 'no-watch': true } })

		expect(schemaWatcherCtorMock).not.toHaveBeenCalled()
	})

	test('spawns vite process with selected port', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue(tempDir.path)
		findSchemaFileMock.mockResolvedValue(null)

		await devCommand.run({ args: { ...defaultArgs(), port: '4123' } })

		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'vite',
				args: ['--port', '4123'],
			}),
		)
	})

	test('uses ports from kora.config when args are omitted', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue(tempDir.path)
		findSchemaFileMock.mockResolvedValue(null)
		loadKoraConfigMock.mockResolvedValue({
			dev: {
				port: 4111,
				sync: { enabled: true, port: 3222 },
			},
		})
		await writeFile(join(tempDir.path, 'server.ts'), 'console.log("sync")')

		await devCommand.run({
			args: { 'no-sync': false, 'no-watch': false },
		})

		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'vite', args: ['--port', '4111'] }),
		)
		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'sync',
				env: expect.objectContaining({ PORT: '3222', KORA_SYNC_PORT: '3222' }),
			}),
		)
	})

	test('starts managed sync from config when server.ts is missing', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue(tempDir.path)
		findSchemaFileMock.mockResolvedValue(null)
		loadKoraConfigMock.mockResolvedValue({
			dev: {
				sync: { enabled: true, port: 3777, store: 'memory' },
			},
		})

		await mkdir(join(tempDir.path, 'node_modules', '@kora', 'server'), { recursive: true })
		await writeFile(join(tempDir.path, 'node_modules', '@kora', 'server', 'package.json'), '{}')

		await devCommand.run({ args: { 'no-sync': false, 'no-watch': false } })

		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'sync', command: process.execPath }),
		)
		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'sync',
				args: expect.arrayContaining(['--input-type=module', '--eval']),
				env: expect.objectContaining({
					KORA_DEV_SYNC_CONFIG: JSON.stringify({
						port: 3777,
						store: { type: 'memory' },
					}),
				}),
			}),
		)
	})

	test('starts managed sqlite sync with resolved filename', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue(tempDir.path)
		findSchemaFileMock.mockResolvedValue(null)
		loadKoraConfigMock.mockResolvedValue({
			dev: {
				sync: {
					enabled: true,
					port: 3888,
					store: { type: 'sqlite', filename: './data/dev-sync.db' },
				},
			},
		})

		await mkdir(join(tempDir.path, 'node_modules', '@kora', 'server'), { recursive: true })
		await writeFile(join(tempDir.path, 'node_modules', '@kora', 'server', 'package.json'), '{}')

		await devCommand.run({ args: { 'no-sync': false, 'no-watch': false } })

		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'sync',
				env: expect.objectContaining({
					KORA_DEV_SYNC_CONFIG: JSON.stringify({
						port: 3888,
						store: { type: 'sqlite', filename: join(tempDir.path, 'data', 'dev-sync.db') },
					}),
				}),
			}),
		)
	})

	test('starts managed postgres sync with connection string', async () => {
		const { devCommand } = await import('./dev-command')
		findProjectRootMock.mockResolvedValue(tempDir.path)
		findSchemaFileMock.mockResolvedValue(null)
		loadKoraConfigMock.mockResolvedValue({
			dev: {
				sync: {
					enabled: true,
					port: 3999,
					store: {
						type: 'postgres',
						connectionString: 'postgres://user:pass@localhost:5432/kora_dev',
					},
				},
			},
		})

		await mkdir(join(tempDir.path, 'node_modules', '@kora', 'server'), { recursive: true })
		await writeFile(join(tempDir.path, 'node_modules', '@kora', 'server', 'package.json'), '{}')

		await devCommand.run({ args: { 'no-sync': false, 'no-watch': false } })

		expect(processManagerSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'sync',
				env: expect.objectContaining({
					KORA_DEV_SYNC_CONFIG: JSON.stringify({
						port: 3999,
						store: {
							type: 'postgres',
							connectionString: 'postgres://user:pass@localhost:5432/kora_dev',
						},
					}),
				}),
			}),
		)
	})
})

function defaultArgs(): Record<string, unknown> {
	return {
		port: '5173',
		'sync-port': '3001',
		'no-sync': false,
		'no-watch': false,
	}
}
