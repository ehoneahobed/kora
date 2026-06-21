import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test.describe('CLI scaffolding', () => {
	let tmpDir: string

	test.beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'kora-scaffold-'))
	})

	test.afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	test('scaffold creates expected files under 10s', async () => {
		const projectDir = join(tmpDir, 'test-app')
		const start = Date.now()

		const cliEntry = join(process.cwd(), '..', 'packages', 'cli', 'dist', 'create.js')
		execSync(
			`node ${cliEntry} test-app --template react-basic --skip-install --yes --platform web --framework react --no-sync --no-tailwind`,
			{
				timeout: 10_000,
				stdio: 'pipe',
				cwd: tmpDir,
				env: { ...process.env, NODE_ENV: 'test' },
			},
		)

		const elapsed = Date.now() - start
		expect(elapsed).toBeLessThan(10_000)

		// Verify expected files exist
		expect(existsSync(join(projectDir, 'package.json'))).toBe(true)
		expect(existsSync(join(projectDir, 'src'))).toBe(true)
		expect(existsSync(join(projectDir, 'vite.config.ts'))).toBe(true)
		expect(existsSync(join(projectDir, 'tsconfig.json'))).toBe(true)
	})
})
