import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AwsLightsailCommandRunner } from './aws-lightsail-adapter'
import { AwsLightsailAdapter } from './aws-lightsail-adapter'

describe('AwsLightsailAdapter', () => {
	test('detect returns true when aws CLI is available', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['--version'],
				result: { exitCode: 0, stdout: 'aws-cli/2.15.0', stderr: '' },
			},
		])
		const adapter = new AwsLightsailAdapter({ runner })
		expect(await adapter.detect()).toBe(true)
	})

	test('detect returns false when aws CLI is not available', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['--version'],
				result: { exitCode: 1, stdout: '', stderr: 'command not found' },
			},
		])
		const adapter = new AwsLightsailAdapter({ runner })
		expect(await adapter.detect()).toBe(false)
	})

	test('authenticate throws when not authenticated', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['sts', 'get-caller-identity'],
				result: { exitCode: 1, stdout: '', stderr: 'Unable to locate credentials' },
			},
		])
		const adapter = new AwsLightsailAdapter({ runner })
		await expect(adapter.authenticate()).rejects.toThrow('AWS CLI is not authenticated')
	})

	test('provision creates Lightsail container service', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['lightsail', 'create-container-service'],
				result: { exitCode: 0, stdout: '{}', stderr: '' },
			},
		])
		const adapter = new AwsLightsailAdapter({ runner })
		const result = await adapter.provision({
			projectRoot: '/tmp/test',
			appName: 'my-app',
			region: 'us-east-1',
			environment: 'production',
			confirm: false,
		})

		expect(result.applicationId).toBe('my-app')
		expect(result.secretsSet).toContain('PORT')
	})

	test('provision succeeds when service already exists', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['lightsail', 'create-container-service'],
				result: { exitCode: 1, stdout: '', stderr: 'Service already exists' },
			},
		])
		const adapter = new AwsLightsailAdapter({ runner })
		const result = await adapter.provision({
			projectRoot: '/tmp/test',
			appName: 'my-app',
			region: 'us-east-1',
			environment: 'production',
			confirm: false,
		})

		expect(result.applicationId).toBe('my-app')
	})

	test('deploy builds, pushes image, and creates deployment', async () => {
		const runner = createRunnerMock([
			{
				commandMatcher: 'docker',
				matcher: ['build'],
				result: { exitCode: 0, stdout: 'built', stderr: '' },
			},
			{
				matcher: ['lightsail', 'push-container-image'],
				result: {
					exitCode: 0,
					stdout: 'Refer to this image as ":my-app.latest.1" in deployments.',
					stderr: '',
				},
			},
			{
				matcher: ['lightsail', 'create-container-service-deployment'],
				result: { exitCode: 0, stdout: '{}', stderr: '' },
			},
			{
				matcher: ['lightsail', 'get-container-services'],
				result: {
					exitCode: 0,
					stdout: JSON.stringify({
						containerServices: [
							{
								url: 'https://my-app.abc123.us-east-1.cs.amazonlightsail.com',
							},
						],
					}),
					stderr: '',
				},
			},
		])
		const adapter = new AwsLightsailAdapter({
			runner,
			context: {
				projectRoot: '/tmp/test',
				appName: 'my-app',
				region: 'us-east-1',
			},
		})
		const result = await adapter.deploy({
			clientDirectory: '/tmp/test/.kora/deploy/dist',
			serverBundlePath: '/tmp/test/.kora/deploy/server-bundled.js',
			deployDirectory: '/tmp/test/.kora/deploy',
		})

		expect(result.liveUrl).toContain('amazonlightsail.com')
		expect(result.syncUrl).toContain('kora-sync')
		expect(result.deploymentId).toBeTruthy()
	})

	describe('the auth secret reaches the container (templates read KORA_AUTH_SECRET)', () => {
		const keys = ['KORA_AUTH_SECRET', 'KORA_AUTH_SECRET_PREVIOUS', 'AUTH_SECRET'] as const
		let saved: Record<string, string | undefined> = {}
		beforeEach(() => {
			saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
			for (const key of keys) delete process.env[key]
		})
		afterEach(() => {
			for (const key of keys) {
				if (saved[key] === undefined) delete process.env[key]
				else process.env[key] = saved[key]
			}
			vi.restoreAllMocks()
		})

		async function deployedEnvironment(): Promise<Record<string, string>> {
			const runner = createRunnerMock([
				{
					matcher: ['lightsail', 'push-container-image'],
					result: { exitCode: 0, stdout: 'Refer to this image as ":my-app.latest.1"', stderr: '' },
				},
			])
			const adapter = new AwsLightsailAdapter({
				runner,
				context: { projectRoot: '/tmp/test', appName: 'my-app', region: 'us-east-1' },
			})
			await adapter.deploy({
				clientDirectory: '/tmp/test/.kora/deploy/dist',
				serverBundlePath: '/tmp/test/.kora/deploy/server-bundled.js',
				deployDirectory: '/tmp/test/.kora/deploy',
			})
			const call = runner.run.mock.calls.find((c) =>
				(c[1] as string[]).includes('create-container-service-deployment'),
			)
			const args = (call?.[1] ?? []) as string[]
			const containers = JSON.parse(args[args.indexOf('--containers') + 1] ?? '{}') as Record<
				string,
				{ environment: Record<string, string> }
			>
			return Object.values(containers)[0]?.environment ?? {}
		}

		test('KORA_AUTH_SECRET and KORA_AUTH_SECRET_PREVIOUS are forwarded', async () => {
			process.env.KORA_AUTH_SECRET = 'current-secret'
			process.env.KORA_AUTH_SECRET_PREVIOUS = 'previous-secret'
			const environment = await deployedEnvironment()
			expect(environment.KORA_AUTH_SECRET).toBe('current-secret')
			expect(environment.KORA_AUTH_SECRET_PREVIOUS).toBe('previous-secret')
		})

		test('the old AUTH_SECRET name still turns auth on, with a warning', async () => {
			process.env.AUTH_SECRET = 'legacy-secret'
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const environment = await deployedEnvironment()
			expect(environment.KORA_AUTH_SECRET).toBe('legacy-secret')
			expect(warn.mock.calls.flat().join(' ')).toContain('KORA_AUTH_SECRET')
		})

		test('every setting a template server reads is forwarded or set inside the container', async () => {
			const { readFileSync, readdirSync, existsSync } = await import('node:fs')
			const { join } = await import('node:path')
			const root = join(__dirname, '../../../../templates')
			const read = new Set<string>()
			for (const template of readdirSync(root)) {
				const server = join(root, template, 'server.ts')
				if (!existsSync(server)) continue
				for (const match of readFileSync(server, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
					if (match[1]) read.add(match[1])
				}
			}
			// Set by the adapter, or a path inside the container with a default.
			const insideContainer = new Set(['PORT', 'KORA_AUTH_DB', 'KORA_SERVER_DB', 'KORA_SYNC_PATH'])
			const expected = [...read].filter((name) => !insideContainer.has(name)).sort()
			expect(expected.length).toBeGreaterThan(0)
			for (const name of expected) process.env[name] = `value-of-${name}`
			try {
				const environment = await deployedEnvironment()
				expect(expected.filter((name) => environment[name] !== `value-of-${name}`)).toEqual([])
			} finally {
				for (const name of expected) delete process.env[name]
			}
		})

		// createProductionServer and the stores read settings from the environment themselves
		// (blob store, insights token, allowed origins): a template never names them, so the
		// template check above cannot see them. Scan the framework's own readers instead.
		test('every KORA_* setting the production server reads is forwarded', async () => {
			const { readFileSync } = await import('node:fs')
			const { join } = await import('node:path')
			const packages = join(__dirname, '../../../../..')
			const readers = [
				'server/src/server/production-server.ts',
				'server/src/server/host-settings.ts',
				'server/src/server/cross-origin.ts',
				'server/src/logging/structured-logger.ts',
				'store/src/blob/open-blob-store.ts',
				'auth/src/provider/adapter.ts',
				'auth/src/provider/built-in/quickstart-server.ts',
			]
			const read = new Set<string>()
			for (const file of readers) {
				const source = readFileSync(join(packages, file), 'utf8')
				for (const match of source.matchAll(/env\.(KORA_[A-Z0-9_]+)|'(KORA_[A-Z0-9_]+)'/g)) {
					read.add((match[1] ?? match[2]) as string)
				}
			}
			const expected = [...read].sort()
			expect(expected).toContain('KORA_BLOB_STORE_URL')
			for (const name of expected) process.env[name] = `value-of-${name}`
			try {
				const environment = await deployedEnvironment()
				expect(expected.filter((name) => environment[name] !== `value-of-${name}`)).toEqual([])
			} finally {
				for (const name of expected) delete process.env[name]
			}
		})

		test('KORA_AUTH_SECRET wins over AUTH_SECRET when both are set', async () => {
			process.env.KORA_AUTH_SECRET = 'current-secret'
			process.env.AUTH_SECRET = 'legacy-secret'
			vi.spyOn(console, 'warn').mockImplementation(() => {})
			expect((await deployedEnvironment()).KORA_AUTH_SECRET).toBe('current-secret')
		})
	})

	test('status returns healthy for running service', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['lightsail', 'get-container-services'],
				result: {
					exitCode: 0,
					stdout: JSON.stringify({
						containerServices: [
							{
								state: 'RUNNING',
								url: 'https://my-app.abc.us-east-1.cs.amazonlightsail.com',
								currentDeployment: { state: 'ACTIVE' },
							},
						],
					}),
					stderr: '',
				},
			},
		])
		const adapter = new AwsLightsailAdapter({
			runner,
			context: {
				projectRoot: '/tmp/test',
				appName: 'my-app',
				region: 'us-east-1',
			},
		})
		const status = await adapter.status()
		expect(status.state).toBe('healthy')
		expect(status.liveUrl).toContain('amazonlightsail.com')
	})

	test('status returns pending when deploying', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['lightsail', 'get-container-services'],
				result: {
					exitCode: 0,
					stdout: JSON.stringify({
						containerServices: [
							{
								state: 'DEPLOYING',
								url: '',
								currentDeployment: { state: 'ACTIVATING' },
							},
						],
					}),
					stderr: '',
				},
			},
		])
		const adapter = new AwsLightsailAdapter({
			runner,
			context: {
				projectRoot: '/tmp/test',
				appName: 'my-app',
				region: 'us-east-1',
			},
		})
		const status = await adapter.status()
		expect(status.state).toBe('pending')
	})

	test('logs parses Lightsail container log events', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['lightsail', 'get-container-log'],
				result: {
					exitCode: 0,
					stdout: JSON.stringify({
						logEvents: [
							{ createdAt: '2024-01-01T00:00:00Z', message: 'info: started' },
							{ createdAt: '2024-01-01T00:00:01Z', message: 'error: crash' },
						],
					}),
					stderr: '',
				},
			},
		])
		const adapter = new AwsLightsailAdapter({
			runner,
			context: {
				projectRoot: '/tmp/test',
				appName: 'my-app',
				region: 'us-east-1',
			},
		})
		const lines = []
		for await (const line of adapter.logs({ tail: 10 })) {
			lines.push(line)
		}
		expect(lines).toHaveLength(2)
		expect(lines[0]?.level).toBe('info')
		expect(lines[1]?.level).toBe('error')
	})

	test('rollback redeploys previous deployment', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['lightsail', 'get-container-service-deployments'],
				result: {
					exitCode: 0,
					stdout: JSON.stringify({
						deployments: [
							{
								state: 'ACTIVE',
								containers: { 'my-app': { image: ':my-app.latest.2' } },
								publicEndpoint: { containerName: 'my-app', containerPort: 3001 },
							},
							{
								state: 'INACTIVE',
								containers: { 'my-app': { image: ':my-app.latest.1' } },
								publicEndpoint: { containerName: 'my-app', containerPort: 3001 },
							},
						],
					}),
					stderr: '',
				},
			},
			{
				matcher: ['lightsail', 'create-container-service-deployment'],
				result: { exitCode: 0, stdout: '{}', stderr: '' },
			},
		])
		const adapter = new AwsLightsailAdapter({
			runner,
			context: {
				projectRoot: '/tmp/test',
				appName: 'my-app',
				region: 'us-east-1',
			},
		})
		await adapter.rollback('previous')
		expect(runner.run).toHaveBeenCalledWith(
			'aws',
			expect.arrayContaining(['lightsail', 'create-container-service-deployment']),
			'/tmp/test',
		)
	})

	test('rollback throws when no previous deployment', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['lightsail', 'get-container-service-deployments'],
				result: {
					exitCode: 0,
					stdout: JSON.stringify({
						deployments: [
							{
								state: 'ACTIVE',
								containers: {},
								publicEndpoint: {},
							},
						],
					}),
					stderr: '',
				},
			},
		])
		const adapter = new AwsLightsailAdapter({
			runner,
			context: {
				projectRoot: '/tmp/test',
				appName: 'my-app',
				region: 'us-east-1',
			},
		})
		await expect(adapter.rollback('latest')).rejects.toThrow('No previous deployment found')
	})

	test('requireContext throws when context not set', async () => {
		const runner = createRunnerMock([])
		const adapter = new AwsLightsailAdapter({ runner })
		await expect(
			adapter.deploy({
				clientDirectory: null,
				serverBundlePath: null,
				deployDirectory: '/tmp',
			}),
		).rejects.toThrow('context is not initialized')
	})
})

interface RunnerExpectation {
	commandMatcher?: string
	matcher: string[]
	result: { exitCode: number; stdout: string; stderr: string }
}

function createRunnerMock(expectations: RunnerExpectation[]): AwsLightsailCommandRunner & {
	run: ReturnType<typeof vi.fn>
} {
	return {
		run: vi.fn(async (command: string, args: string[], _cwd: string) => {
			const expectation = expectations.find((item) => {
				if (item.commandMatcher && item.commandMatcher !== command) return false
				return item.matcher.every((segment) => args.includes(segment))
			})
			if (!expectation) {
				return { exitCode: 0, stdout: '', stderr: '' }
			}
			return expectation.result
		}),
	}
}
