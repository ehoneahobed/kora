import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { RailwayCommandRunner } from './railway-adapter'
import { RailwayAdapter } from './railway-adapter'

describe('RailwayAdapter', () => {
	test('provision and deploy return expected live URLs', async () => {
		const tempDir = await makeTempProject()
		try {
			const runner = createRunnerMock([
				{
					matcher: ['init'],
					result: { exitCode: 0, stdout: 'initialized', stderr: '' },
				},
				{
					matcher: ['variables', 'set'],
					result: { exitCode: 0, stdout: 'set', stderr: '' },
				},
				{
					matcher: ['up'],
					result: { exitCode: 0, stdout: 'deployed', stderr: '' },
				},
				{
					matcher: ['status'],
					result: {
						exitCode: 0,
						stdout: JSON.stringify({
							deploymentId: 'rail-dep-1',
							url: 'https://my-kora-app.up.railway.app',
						}),
						stderr: '',
					},
				},
			])

			const adapter = new RailwayAdapter({ runner })
			await adapter.provision({
				projectRoot: tempDir,
				appName: 'my-kora-app',
				region: 'us-west',
				environment: 'preview',
				confirm: false,
			})
			const result = await adapter.deploy({
				clientDirectory: join(tempDir, '.kora', 'deploy', 'dist'),
				serverBundlePath: join(tempDir, '.kora', 'deploy', 'server-bundled.js'),
				deployDirectory: join(tempDir, '.kora', 'deploy'),
			})

			expect(result.deploymentId).toBe('rail-dep-1')
			expect(result.liveUrl).toBe('https://my-kora-app.up.railway.app')
			expect(result.syncUrl).toBe('wss://my-kora-app.up.railway.app/kora-sync')
		} finally {
			await cleanupTempProject(tempDir)
		}
	})

	test('authenticate uses railway login when whoami fails', async () => {
		const tempDir = await makeTempProject()
		try {
			const runner = createRunnerMock([
				{
					matcher: ['whoami'],
					result: { exitCode: 1, stdout: '', stderr: 'not authenticated' },
				},
				{
					matcher: ['login'],
					result: { exitCode: 0, stdout: 'logged in', stderr: '' },
				},
				{
					matcher: ['init'],
					result: { exitCode: 0, stdout: 'initialized', stderr: '' },
				},
				{
					matcher: ['variables', 'set'],
					result: { exitCode: 0, stdout: 'set', stderr: '' },
				},
			])
			const adapter = new RailwayAdapter({ runner })
			await adapter.provision({
				projectRoot: tempDir,
				appName: 'auth-kora-app',
				region: 'us-west',
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
					matcher: ['init'],
					result: { exitCode: 0, stdout: 'initialized', stderr: '' },
				},
				{
					matcher: ['variables', 'set'],
					result: { exitCode: 0, stdout: 'set', stderr: '' },
				},
				{
					matcher: ['logs'],
					result: {
						exitCode: 0,
						stdout: 'info startup complete\nwarn high memory\nerror request failed',
						stderr: '',
					},
				},
			])
			const adapter = new RailwayAdapter({ runner })
			await adapter.provision({
				projectRoot: tempDir,
				appName: 'log-kora-app',
				region: 'us-west',
				environment: 'preview',
				confirm: false,
			})

			const lines = []
			for await (const line of adapter.logs({ tail: 20 })) {
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

function createRunnerMock(expectations: RunnerExpectation[]): RailwayCommandRunner & {
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
	const path = await fs.mkdtemp(join(os.tmpdir(), 'kora-railway-adapter-test-'))
	await mkdir(join(path, '.kora', 'deploy'), { recursive: true })
	await writeFile(join(path, '.kora', 'deploy', 'railway.json'), '{}', 'utf-8')
	await writeFile(join(path, 'server.ts'), 'export {}', 'utf-8')
	return path
}

async function cleanupTempProject(path: string): Promise<void> {
	const fs = await import('node:fs/promises')
	await fs.rm(path, { recursive: true, force: true })
}
