import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/fixtures/test-helpers'
import {
	readDeployState,
	resetDeployState,
	resolveDeployDirectory,
	resolveDeployStatePath,
	updateDeployState,
	writeDeployState,
} from './deploy-state'

describe('deploy-state', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('writes and reads deploy state', async () => {
		const now = new Date('2026-04-07T00:00:00.000Z')
		await writeDeployState(
			tempDir.path,
			{
				platform: 'fly',
				appName: 'my-kora-app',
				region: 'iad',
				projectRoot: tempDir.path,
				databaseId: 'db-1',
				lastDeploymentId: 'deploy-1',
				liveUrl: 'https://example.fly.dev',
				syncUrl: 'wss://example.fly.dev/kora-sync',
			},
			now,
		)

		const state = await readDeployState(tempDir.path)
		expect(state).toBeTruthy()
		expect(state?.platform).toBe('fly')
		expect(state?.appName).toBe('my-kora-app')
		expect(state?.createdAt).toBe('2026-04-07T00:00:00.000Z')
		expect(state?.updatedAt).toBe('2026-04-07T00:00:00.000Z')
	})

	test('updates deploy state while preserving createdAt', async () => {
		await writeDeployState(
			tempDir.path,
			{
				platform: 'fly',
				appName: 'my-kora-app',
				region: 'iad',
				projectRoot: tempDir.path,
			},
			new Date('2026-04-07T00:00:00.000Z'),
		)

		const updated = await updateDeployState(
			tempDir.path,
			{
				platform: 'docker',
				lastDeploymentId: 'deploy-2',
				liveUrl: 'https://docker-host.example.com',
			},
			new Date('2026-04-07T01:00:00.000Z'),
		)
		expect(updated.platform).toBe('docker')
		expect(updated.createdAt).toBe('2026-04-07T00:00:00.000Z')
		expect(updated.updatedAt).toBe('2026-04-07T01:00:00.000Z')
		expect(updated.lastDeploymentId).toBe('deploy-2')
	})

	test('readDeployState returns null when file is missing', async () => {
		const state = await readDeployState(tempDir.path)
		expect(state).toBeNull()
	})

	test('resetDeployState deletes deploy directory', async () => {
		await writeDeployState(tempDir.path, {
			platform: 'fly',
			appName: 'reset-app',
			region: 'iad',
			projectRoot: tempDir.path,
		})

		await resetDeployState(tempDir.path)
		const state = await readDeployState(tempDir.path)
		expect(state).toBeNull()
	})

	test('resolve helpers return expected absolute paths', async () => {
		expect(resolveDeployDirectory(tempDir.path)).toBe(join(tempDir.path, '.kora', 'deploy'))
		expect(resolveDeployStatePath(tempDir.path)).toBe(
			join(tempDir.path, '.kora', 'deploy', 'deploy.json'),
		)
	})

	test('throws on invalid persisted payload', async () => {
		const deployDirectory = resolveDeployDirectory(tempDir.path)
		await mkdir(deployDirectory, { recursive: true })
		await writeFile(
			join(deployDirectory, 'deploy.json'),
			JSON.stringify({ platform: 'invalid' }),
			'utf-8',
		)

		await expect(readDeployState(tempDir.path)).rejects.toThrowError(/Invalid deploy state/)
	})
})
