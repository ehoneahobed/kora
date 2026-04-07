import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import {
	applyEditorWorkspacePreset,
	detectEditorFromEnvironment,
	detectGitContext,
	detectMonorepoContext,
	resolveMonorepoTargetDirectory,
} from './environment-detection'

describe('detectEditorFromEnvironment', () => {
	test('detects cursor from TERM_PROGRAM', () => {
		const result = detectEditorFromEnvironment({ TERM_PROGRAM: 'cursor' })
		expect(result.editor).toBe('cursor')
		expect(result.source).toBe('env')
	})

	test('detects vscode from vscode env variables', () => {
		const result = detectEditorFromEnvironment({ VSCODE_PID: '12345' })
		expect(result.editor).toBe('vscode')
		expect(result.source).toBe('env')
	})

	test('returns unknown when no signals are present', () => {
		const result = detectEditorFromEnvironment({})
		expect(result.editor).toBe('unknown')
		expect(result.source).toBe('none')
	})
})

describe('detectGitContext', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('detects repository root from nested directory', async () => {
		const repoRoot = join(tempDir.path, 'repo')
		const nested = join(repoRoot, 'packages', 'app')
		await mkdir(join(repoRoot, '.git'), { recursive: true })
		await mkdir(nested, { recursive: true })

		const result = await detectGitContext(nested)
		expect(result.hasRepository).toBe(true)
		expect(result.repositoryRoot).toBe(repoRoot)
	})

	test('returns false when no repository exists', async () => {
		const result = await detectGitContext(tempDir.path)
		expect(result.hasRepository).toBe(false)
		expect(result.repositoryRoot).toBeNull()
	})
})

describe('detectMonorepoContext', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('detects pnpm workspace monorepo', async () => {
		const root = join(tempDir.path, 'workspace')
		const nested = join(root, 'apps', 'client')
		await mkdir(nested, { recursive: true })
		await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n', 'utf-8')

		const result = await detectMonorepoContext(nested)
		expect(result.isMonorepo).toBe(true)
		expect(result.root).toBe(root)
		expect(result.kind).toBe('pnpm-workspace')
	})

	test('detects npm workspaces from package.json', async () => {
		const root = join(tempDir.path, 'workspace')
		const nested = join(root, 'packages', 'feature')
		await mkdir(nested, { recursive: true })
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'workspace', workspaces: ['packages/*'] }),
			'utf-8',
		)

		const result = await detectMonorepoContext(nested)
		expect(result.isMonorepo).toBe(true)
		expect(result.root).toBe(root)
		expect(result.kind).toBe('npm-workspaces')
	})

	test('returns none when no monorepo markers are found', async () => {
		const result = await detectMonorepoContext(tempDir.path)
		expect(result.isMonorepo).toBe(false)
		expect(result.root).toBeNull()
		expect(result.kind).toBe('none')
	})
})

describe('applyEditorWorkspacePreset', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('writes vscode extension recommendations for vscode-like editors', async () => {
		const result = await applyEditorWorkspacePreset({
			targetDir: tempDir.path,
			editor: 'vscode',
		})
		expect(result.applied).toBe(true)
		expect(result.filePath).toBe(join(tempDir.path, '.vscode', 'extensions.json'))
	})

	test('does not apply preset for unsupported editors', async () => {
		const result = await applyEditorWorkspacePreset({
			targetDir: tempDir.path,
			editor: 'zed',
		})
		expect(result.applied).toBe(false)
		expect(result.filePath).toBeNull()
	})
})

describe('resolveMonorepoTargetDirectory', () => {
	test('returns packages/<name> path', () => {
		const result = resolveMonorepoTargetDirectory('/repo', 'my-kora-app')
		expect(result).toBe('/repo/packages/my-kora-app')
	})
})
