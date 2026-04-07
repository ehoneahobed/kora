import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockFindProjectRoot = vi.fn()
const mockCreatePromptClient = vi.fn()
const mockCreateLogger = vi.fn()
const mockReadDeployState = vi.fn()
const mockResetDeployState = vi.fn()
const mockResolveDeployDirectory = vi.fn()
const mockUpdateDeployState = vi.fn()
const mockWriteDeployState = vi.fn()
const mockWriteDockerfileArtifact = vi.fn()
const mockWriteDockerIgnoreArtifact = vi.fn()
const mockWriteFlyTomlArtifact = vi.fn()
const mockBuildClient = vi.fn()
const mockBundleServer = vi.fn()
let loggerMock: {
	banner: ReturnType<typeof vi.fn>
	info: ReturnType<typeof vi.fn>
	success: ReturnType<typeof vi.fn>
	warn: ReturnType<typeof vi.fn>
	error: ReturnType<typeof vi.fn>
	step: ReturnType<typeof vi.fn>
	blank: ReturnType<typeof vi.fn>
}

vi.mock('../../utils/fs-helpers', () => ({
	findProjectRoot: mockFindProjectRoot,
}))

vi.mock('../../prompts/prompt-client', () => ({
	createPromptClient: mockCreatePromptClient,
}))

vi.mock('../../utils/logger', () => ({
	createLogger: mockCreateLogger,
}))

vi.mock('./state/deploy-state', () => ({
	readDeployState: mockReadDeployState,
	resetDeployState: mockResetDeployState,
	resolveDeployDirectory: mockResolveDeployDirectory,
	updateDeployState: mockUpdateDeployState,
	writeDeployState: mockWriteDeployState,
}))

vi.mock('./artifacts/dockerfile-generator', () => ({
	writeDockerfileArtifact: mockWriteDockerfileArtifact,
	writeDockerIgnoreArtifact: mockWriteDockerIgnoreArtifact,
}))

vi.mock('./artifacts/fly-toml-generator', () => ({
	writeFlyTomlArtifact: mockWriteFlyTomlArtifact,
}))

vi.mock('./builder/client-builder', () => ({
	buildClient: mockBuildClient,
}))

vi.mock('./builder/server-bundler', () => ({
	bundleServer: mockBundleServer,
}))

interface DeployArgs {
	_: string[]
	platform: string
	app: string
	region: string
	reset: boolean
	confirm: boolean
	prod: boolean
}

interface DeployRunContext {
	args: DeployArgs
	rawArgs: string[]
	cmd: unknown
}

describe('deployCommand', () => {
	beforeEach(() => {
		mockFindProjectRoot.mockReset()
		mockCreatePromptClient.mockReset()
		mockCreateLogger.mockReset()
		mockReadDeployState.mockReset()
		mockResetDeployState.mockReset()
		mockResolveDeployDirectory.mockReset()
		mockUpdateDeployState.mockReset()
		mockWriteDeployState.mockReset()
		mockWriteDockerfileArtifact.mockReset()
		mockWriteDockerIgnoreArtifact.mockReset()
		mockWriteFlyTomlArtifact.mockReset()
		mockBuildClient.mockReset()
		mockBundleServer.mockReset()

		loggerMock = {
			banner: vi.fn(),
			info: vi.fn(),
			success: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			step: vi.fn(),
			blank: vi.fn(),
		}
		mockCreateLogger.mockReturnValue(loggerMock)
		mockCreatePromptClient.mockReturnValue({
			text: vi.fn(),
			select: vi.fn().mockResolvedValue('fly'),
			confirm: vi.fn(),
			intro: vi.fn(),
			outro: vi.fn(),
		})
		mockFindProjectRoot.mockResolvedValue('/project')
		mockReadDeployState.mockResolvedValue(null)
		mockResolveDeployDirectory.mockReturnValue('/project/.kora/deploy')
		mockWriteDockerfileArtifact.mockResolvedValue('/project/.kora/deploy/Dockerfile')
		mockWriteDockerIgnoreArtifact.mockResolvedValue('/project/.kora/deploy/.dockerignore')
		mockWriteFlyTomlArtifact.mockResolvedValue('/project/.kora/deploy/fly.toml')
		mockBuildClient.mockResolvedValue({ outDir: '/project/.kora/deploy/dist' })
		mockBundleServer.mockResolvedValue({
			entryFilePath: '/project/server.ts',
			outputFilePath: '/project/.kora/deploy/server-bundled.js',
		})
		mockWriteDeployState.mockResolvedValue({
			platform: 'fly',
		})
		mockUpdateDeployState.mockResolvedValue({
			platform: 'fly',
		})
	})

	test('resets deploy state when --reset is enabled', async () => {
		const { deployCommand } = await import('./deploy-command')
		await deployCommand.run?.({
			args: {
				_: [],
				platform: 'fly',
				app: 'my-app',
				region: 'iad',
				reset: true,
				confirm: false,
				prod: false,
			},
			rawArgs: [],
			cmd: deployCommand,
		} as DeployRunContext)

		expect(mockResetDeployState).toHaveBeenCalledWith('/project')
		expect(mockWriteDockerfileArtifact).not.toHaveBeenCalled()
	})

	test('creates initial deploy state and artifacts', async () => {
		const { deployCommand } = await import('./deploy-command')
		await deployCommand.run?.({
			args: {
				_: [],
				platform: 'fly',
				app: 'my-app',
				region: 'iad',
				reset: false,
				confirm: false,
				prod: false,
			},
			rawArgs: [],
			cmd: deployCommand,
		} as DeployRunContext)

		expect(mockWriteDockerfileArtifact).toHaveBeenCalledWith('/project/.kora/deploy')
		expect(mockWriteDockerIgnoreArtifact).toHaveBeenCalledWith('/project/.kora/deploy')
		expect(mockWriteFlyTomlArtifact).toHaveBeenCalledWith('/project/.kora/deploy', {
			appName: 'my-app',
			region: 'iad',
		})
		expect(mockBundleServer).toHaveBeenCalledWith({
			projectRoot: '/project',
			deployDirectory: '/project/.kora/deploy',
		})
		expect(mockBuildClient).toHaveBeenCalledWith({
			projectRoot: '/project',
			outDir: '/project/.kora/deploy/dist',
			mode: 'production',
		})
		expect(mockWriteDeployState).toHaveBeenCalledWith('/project', {
			platform: 'fly',
			appName: 'my-app',
			region: 'iad',
			projectRoot: '/project',
		})
		expect(mockUpdateDeployState).not.toHaveBeenCalled()
	})

	test('updates existing deploy state on subsequent runs', async () => {
		mockReadDeployState.mockResolvedValue({
			platform: 'fly',
			appName: 'existing-app',
			region: 'lhr',
		})
		const { deployCommand } = await import('./deploy-command')
		await deployCommand.run?.({
			args: {
				_: [],
				platform: 'fly',
				app: 'existing-app',
				region: 'lhr',
				reset: false,
				confirm: true,
				prod: true,
			},
			rawArgs: [],
			cmd: deployCommand,
		} as DeployRunContext)

		expect(mockUpdateDeployState).toHaveBeenCalledWith('/project', {
			platform: 'fly',
			appName: 'existing-app',
			region: 'lhr',
			projectRoot: '/project',
		})
		expect(mockWriteDeployState).not.toHaveBeenCalled()
	})

	test('status subcommand logs warning without state', async () => {
		const { deployCommand } = await import('./deploy-command')
		const subCommands = deployCommand.subCommands as Record<
			string,
			{ run?: (ctx: unknown) => Promise<void> }
		>
		await subCommands.status?.run?.({
			args: {
				_: [],
				platform: 'fly',
				app: 'status-app',
				region: 'iad',
				reset: false,
				confirm: false,
				prod: false,
			},
			rawArgs: [],
			cmd: subCommands.status,
		} as DeployRunContext)
		expect(loggerMock.warn).toHaveBeenCalledWith(
			'No deployment state found. Run `kora deploy` first.',
		)
	})

	test('status subcommand prints persisted state values', async () => {
		mockReadDeployState.mockResolvedValue({
			platform: 'fly',
			appName: 'my-app',
			region: 'iad',
			lastDeploymentId: 'dep-123',
			liveUrl: 'https://my-app.fly.dev',
			syncUrl: 'wss://my-app.fly.dev/kora-sync',
		})
		const { deployCommand } = await import('./deploy-command')
		const subCommands = deployCommand.subCommands as Record<
			string,
			{ run?: (ctx: unknown) => Promise<void> }
		>
		await subCommands.status?.run?.({
			args: {
				_: [],
				platform: 'fly',
				app: 'status-app',
				region: 'iad',
				reset: false,
				confirm: false,
				prod: false,
			},
			rawArgs: [],
			cmd: subCommands.status,
		} as DeployRunContext)
		expect(loggerMock.info).toHaveBeenCalledWith('Platform: fly')
		expect(loggerMock.step).toHaveBeenCalledWith('App: my-app')
		expect(loggerMock.step).toHaveBeenCalledWith('Live URL: https://my-app.fly.dev')
	})
})

describe('deploy command integration', () => {
	test('status subcommand reads real deploy state file', async () => {
		const fsRoot = await makeTempProject()
		try {
			mockFindProjectRoot.mockResolvedValue(fsRoot)
			mockReadDeployState.mockImplementation(async (projectRoot: string) => {
				const statePath = join(projectRoot, '.kora', 'deploy', 'deploy.json')
				const source = await import('node:fs/promises').then(({ readFile }) =>
					readFile(statePath, 'utf-8'),
				)
				return JSON.parse(source)
			})
			const { deployCommand } = await import('./deploy-command')
			const subCommands = deployCommand.subCommands as Record<
				string,
				{ run?: (ctx: unknown) => Promise<void> }
			>
			await subCommands.status?.run?.({
				args: {
					_: [],
					platform: 'fly',
					app: 'status-app',
					region: 'iad',
					reset: false,
					confirm: false,
					prod: false,
				},
				rawArgs: [],
				cmd: subCommands.status,
			} as DeployRunContext)
			expect(mockReadDeployState).toHaveBeenCalledWith(fsRoot)
		} finally {
			await import('node:fs/promises').then(({ rm }) =>
				rm(fsRoot, { recursive: true, force: true }),
			)
		}
	})
})

async function makeTempProject(): Promise<string> {
	const { mkdtemp } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const root = await mkdtemp(join(tmpdir(), 'kora-deploy-command-test-'))
	await mkdir(join(root, '.kora', 'deploy'), { recursive: true })
	await writeFile(
		join(root, '.kora', 'deploy', 'deploy.json'),
		`${JSON.stringify(
			{
				platform: 'fly',
				appName: 'integration-app',
				region: 'iad',
				projectRoot: root,
				liveUrl: 'https://integration-app.fly.dev',
				syncUrl: null,
				databaseId: null,
				lastDeploymentId: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
		'utf-8',
	)
	return root
}
