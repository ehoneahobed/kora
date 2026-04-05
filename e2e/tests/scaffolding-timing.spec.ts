import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

    // Run CLI scaffold with --template and --skip-install
    execSync(
      `node ${join(process.cwd(), '..', 'packages', 'cli', 'dist', 'index.js')} create ${projectDir} --template react-basic --skip-install`,
      { timeout: 10_000, stdio: 'pipe' },
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
