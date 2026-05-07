import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { AwsCommandRunner } from './aws-ecs-adapter'
import { AwsEcsAdapter } from './aws-ecs-adapter'

describe('AwsEcsAdapter', () => {
	test('detect returns true when aws CLI is available', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['--version'],
				result: { exitCode: 0, stdout: 'aws-cli/2.15.0', stderr: '' },
			},
		])
		const adapter = new AwsEcsAdapter({ runner })
		expect(await adapter.detect()).toBe(true)
	})

	test('detect returns false when aws CLI is not available', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['--version'],
				result: { exitCode: 1, stdout: '', stderr: 'command not found' },
			},
		])
		const adapter = new AwsEcsAdapter({ runner })
		expect(await adapter.detect()).toBe(false)
	})

	test('authenticate throws when not authenticated', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['sts', 'get-caller-identity'],
				result: { exitCode: 1, stdout: '', stderr: 'Unable to locate credentials' },
			},
		])
		const adapter = new AwsEcsAdapter({ runner })
		await expect(adapter.authenticate()).rejects.toThrow('AWS CLI is not authenticated')
	})

	test('provision creates ECR repo, cluster, and log group', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['ecr', 'create-repository'],
				result: { exitCode: 0, stdout: '{}', stderr: '' },
			},
			{
				matcher: ['sts', 'get-caller-identity'],
				result: { exitCode: 0, stdout: '123456789012', stderr: '' },
			},
			{
				matcher: ['ecs', 'create-cluster'],
				result: { exitCode: 0, stdout: '{}', stderr: '' },
			},
			{
				matcher: ['logs', 'create-log-group'],
				result: { exitCode: 0, stdout: '', stderr: '' },
			},
		])
		const adapter = new AwsEcsAdapter({ runner })
		const result = await adapter.provision({
			projectRoot: '/tmp/test',
			appName: 'my-app',
			region: 'us-east-1',
			environment: 'production',
			confirm: false,
		})

		expect(result.applicationId).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/kora/my-app')
		expect(result.secretsSet).toContain('PORT')
	})

	test('provision succeeds when ECR repo already exists', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['ecr', 'create-repository'],
				result: { exitCode: 1, stdout: '', stderr: 'RepositoryAlreadyExistsException' },
			},
			{
				matcher: ['sts', 'get-caller-identity'],
				result: { exitCode: 0, stdout: '123456789012', stderr: '' },
			},
			{
				matcher: ['ecs', 'create-cluster'],
				result: { exitCode: 0, stdout: '{}', stderr: '' },
			},
			{
				matcher: ['logs', 'create-log-group'],
				result: { exitCode: 0, stdout: '', stderr: '' },
			},
		])
		const adapter = new AwsEcsAdapter({ runner })
		const result = await adapter.provision({
			projectRoot: '/tmp/test',
			appName: 'my-app',
			region: 'us-east-1',
			environment: 'production',
			confirm: false,
		})

		expect(result.applicationId).toContain('kora/my-app')
	})

	test('deploy builds, pushes, and registers task definition', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['ecr', 'get-login-password'],
				result: { exitCode: 0, stdout: 'token123', stderr: '' },
			},
			{
				matcher: ['sts', 'get-caller-identity'],
				result: { exitCode: 0, stdout: '123456789012', stderr: '' },
			},
			{
				commandMatcher: 'docker',
				matcher: ['login'],
				result: { exitCode: 0, stdout: 'Login Succeeded', stderr: '' },
			},
			{
				commandMatcher: 'docker',
				matcher: ['build'],
				result: { exitCode: 0, stdout: 'built', stderr: '' },
			},
			{
				commandMatcher: 'docker',
				matcher: ['push'],
				result: { exitCode: 0, stdout: 'pushed', stderr: '' },
			},
			{
				matcher: ['ecs', 'register-task-definition'],
				result: { exitCode: 0, stdout: '{}', stderr: '' },
			},
			{
				matcher: ['ecs', 'update-service'],
				result: { exitCode: 0, stdout: '{}', stderr: '' },
			},
		])
		const adapter = new AwsEcsAdapter({
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

		expect(result.liveUrl).toContain('my-app')
		expect(result.syncUrl).toContain('kora-sync')
		expect(result.deploymentId).toBeTruthy()
	})

	test('status returns healthy for running service', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['ecs', 'describe-services'],
				result: {
					exitCode: 0,
					stdout: JSON.stringify({
						services: [{
							status: 'ACTIVE',
							runningCount: 2,
							desiredCount: 2,
						}],
					}),
					stderr: '',
				},
			},
		])
		const adapter = new AwsEcsAdapter({
			runner,
			context: {
				projectRoot: '/tmp/test',
				appName: 'my-app',
				region: 'us-east-1',
			},
		})
		const status = await adapter.status()
		expect(status.state).toBe('healthy')
		expect(status.message).toContain('2/2')
	})

	test('status returns pending when no tasks running', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['ecs', 'describe-services'],
				result: {
					exitCode: 0,
					stdout: JSON.stringify({
						services: [{
							status: 'ACTIVE',
							runningCount: 0,
							desiredCount: 1,
						}],
					}),
					stderr: '',
				},
			},
		])
		const adapter = new AwsEcsAdapter({
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

	test('logs parses CloudWatch events', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['logs', 'get-log-events'],
				result: {
					exitCode: 0,
					stdout: JSON.stringify({
						events: [
							{ timestamp: 1700000000000, message: 'info: server started' },
							{ timestamp: 1700000001000, message: 'error: connection failed' },
						],
					}),
					stderr: '',
				},
			},
		])
		const adapter = new AwsEcsAdapter({
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

	test('rollback updates service with specified task definition', async () => {
		const runner = createRunnerMock([
			{
				matcher: ['ecs', 'update-service'],
				result: { exitCode: 0, stdout: '{}', stderr: '' },
			},
		])
		const adapter = new AwsEcsAdapter({
			runner,
			context: {
				projectRoot: '/tmp/test',
				appName: 'my-app',
				region: 'us-east-1',
			},
		})
		await adapter.rollback('3')
		expect(runner.run).toHaveBeenCalledWith(
			'aws',
			expect.arrayContaining(['ecs', 'update-service', '--task-definition', 'my-app:3']),
			'/tmp/test',
		)
	})

	test('requireContext throws when context not set', async () => {
		const runner = createRunnerMock([])
		const adapter = new AwsEcsAdapter({ runner })
		await expect(adapter.deploy({
			clientDirectory: null,
			serverBundlePath: null,
			deployDirectory: '/tmp',
		})).rejects.toThrow('context is not initialized')
	})
})

interface RunnerExpectation {
	commandMatcher?: string
	matcher: string[]
	result: { exitCode: number; stdout: string; stderr: string }
}

function createRunnerMock(expectations: RunnerExpectation[]): AwsCommandRunner & {
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
