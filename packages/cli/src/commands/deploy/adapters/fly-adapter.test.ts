import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { FlyCommandRunner } from './fly-adapter'
import { FlyAdapter } from './fly-adapter'

describe('FlyAdapter', () => {
	test('provision and deploy return expected live URLs', async () => {
		const tempDir = await makeTempProject()
		try {
			const runner = createRunnerMock([
				{
					matcher: ['apps', 'create'],
					result: { exitCode: 0, stdout: 'created', stderr: '' },
				},
				{
					matcher: ['secrets', 'set'],
					result: { exitCode: 0, stdout: 'set', stderr: '' },
				},
				{
					matcher: ['deploy'],
					result: { exitCode: 0, stdout: 'deployed', stderr: '' },
				},
				{
					matcher: ['status'],
					result: {
						exitCode: 0,
						stdout: JSON.stringify({
							Hostname: 'my-kora-app.fly.dev',
							DeploymentID: 'dep-1',
						}),
						stderr: '',
					},
				},
			])
			const adapter = new FlyAdapter({ runner })
			await adapter.provision({
				projectRoot: tempDir,
				appName: 'my-kora-app',
				region: 'iad',
				environment: 'preview',
				confirm: false,
			})
			const result = await adapter.deploy({
				clientDirectory: join(tempDir, '.kora', 'deploy', 'dist'),
				serverBundlePath: join(tempDir, '.kora', 'deploy', 'server-bundled.js'),
				deployDirectory: join(tempDir, '.kora', 'deploy'),
			})

			expect(result.deploymentId).toBe('dep-1')
			expect(result.liveUrl).toBe('https://my-kora-app.fly.dev')
			expect(result.syncUrl).toBe('wss://my-kora-app.fly.dev/kora-sync')
		} finally {
			await cleanupTempProject(tempDir)
		}
	})

	test('authenticate falls back to login when not authenticated', async () => {
		const tempDir = await makeTempProject()
		try {
			const runner = createRunnerMock([
				{
					matcher: ['auth', 'whoami'],
					result: { exitCode: 1, stdout: '', stderr: 'not logged in' },
				},
				{
					matcher: ['auth', 'login'],
					result: { exitCode: 0, stdout: 'logged in', stderr: '' },
				},
				{
					matcher: ['apps', 'create'],
					result: { exitCode: 0, stdout: 'created', stderr: '' },
				},
				{
					matcher: ['secrets', 'set'],
					result: { exitCode: 0, stdout: 'set', stderr: '' },
				},
			])
			const adapter = new FlyAdapter({ runner })
			await adapter.provision({
				projectRoot: tempDir,
				appName: 'auth-kora-app',
				region: 'iad',
				environment: 'preview',
				confirm: false,
			})
			await adapter.authenticate()
			expect(runner.run).toHaveBeenCalled()
		} finally {
			await cleanupTempProject(tempDir)
		}
	})

	test('logs parses log lines with levels', async () => {
		const tempDir = await makeTempProject()
		try {
			const runner = createRunnerMock([
				{
					matcher: ['apps', 'create'],
					result: { exitCode: 0, stdout: 'created', stderr: '' },
				},
				{
					matcher: ['secrets', 'set'],
					result: { exitCode: 0, stdout: 'set', stderr: '' },
				},
				{
					matcher: ['logs'],
					result: {
						exitCode: 0,
						stdout: 'info startup complete\nwarn disk nearly full\nerror failed request',
						stderr: '',
					},
				},
			])
			const adapter = new FlyAdapter({ runner })
			await adapter.provision({
				projectRoot: tempDir,
				appName: 'log-kora-app',
				region: 'iad',
				environment: 'preview',
				confirm: false,
			})
			const lines = []
			for await (const line of adapter.logs({ tail: 10 })) {
				lines.push(line)
			}
			expect(lines).toHaveLength(3)
			expect(lines[0]?.level).toBe('info')
			expect(lines[1]?.level).toBe('warn')
			expect(lines[2]?.level).toBe('error')
		} finally {
			await cleanupTempProject(tempDir)
		}
	})
})

interface RunnerExpectation {
	matcher: string[]
	result: { exitCode: number; stdout: string; stderr: string }
}

function createRunnerMock(expectations: RunnerExpectation[]): FlyCommandRunner & {
	run: ReturnType<typeof vi.fn>
} {
	return {
		run: vi.fn(async (_command: string, args: string[], _cwd: string) => {
			const expectation = expectations.find((item) =>
				item.matcher.every((segment) => args.includes(segment)),
			)
			if (!expectation) {
				return { exitCode: 0, stdout: '', stderr: '' }
			}
			return expectation.result
		}),
	}
}

async function makeTempProject(): Promise<string> {
	const fs = await import('node:fs/promises')
	const os = await import('node:os')
	const path = await fs.mkdtemp(join(os.tmpdir(), 'kora-fly-adapter-test-'))
	await mkdir(join(path, '.kora', 'deploy'), { recursive: true })
	await writeFile(join(path, '.kora', 'deploy', 'fly.toml'), 'app = "test"', 'utf-8')
	await writeFile(join(path, 'server.ts'), 'export {}', 'utf-8')
	await mkdir(join(path, 'node_modules', '.bin'), { recursive: true })
	await writeFile(join(path, 'node_modules', '.bin', 'flyctl'), '', 'utf-8')
	return path
}

async function cleanupTempProject(path: string): Promise<void> {
	const fs = await import('node:fs/promises')
	await fs.rm(path, { recursive: true, force: true })
}
