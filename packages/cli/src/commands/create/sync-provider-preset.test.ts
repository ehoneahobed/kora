import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { scaffoldTemplate } from './template-engine'
import { applySyncProviderPreset } from './sync-provider-preset'

describe('applySyncProviderPreset', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('rewrites sync server to postgres preset for postgres db', async () => {
		const targetDir = join(tempDir.path, 'sync-postgres')
		await scaffoldTemplate('react-sync', targetDir, {
			projectName: 'sync-postgres',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
			dbProvider: 'neon',
		})

		await applySyncProviderPreset({
			targetDir,
			template: 'react-sync',
			db: 'postgres',
			dbProvider: 'neon',
		})

		const server = await readFile(join(targetDir, 'server.ts'), 'utf-8')
		const env = await readFile(join(targetDir, '.env.example'), 'utf-8')
		const readme = await readFile(join(targetDir, 'README.md'), 'utf-8')
		expect(server).toContain('createPostgresServerStore')
		expect(server).toContain('DATABASE_URL is required')
		expect(server).toContain('PostgreSQL provider preset: Neon')
		expect(readme).toContain('Selected DB provider: neon')
		expect(readme).toContain('createPostgresServerStore')
		expect(env).toContain('DATABASE_URL=')
		expect(env).toContain('neon.tech')
	})

	test('keeps sync server template untouched for sqlite db', async () => {
		const targetDir = join(tempDir.path, 'sync-sqlite')
		await scaffoldTemplate('react-sync', targetDir, {
			projectName: 'sync-sqlite',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
			dbProvider: 'none',
		})

		const before = await readFile(join(targetDir, 'server.ts'), 'utf-8')
		await applySyncProviderPreset({
			targetDir,
			template: 'react-sync',
			db: 'sqlite',
			dbProvider: 'none',
		})
		const after = await readFile(join(targetDir, 'server.ts'), 'utf-8')
		expect(after).toBe(before)
	})

	test('does nothing for non-sync templates', async () => {
		const targetDir = join(tempDir.path, 'basic')
		await scaffoldTemplate('react-basic', targetDir, {
			projectName: 'basic',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
			dbProvider: 'supabase',
		})

		await mkdir(join(targetDir, 'sentinel'), { recursive: true })
		await applySyncProviderPreset({
			targetDir,
			template: 'react-basic',
			db: 'postgres',
			dbProvider: 'supabase',
		})

		const env = await readFile(join(targetDir, '.env.example'), 'utf-8')
		expect(env).not.toContain('DATABASE_URL=')
	})
})
