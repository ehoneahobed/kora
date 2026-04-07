import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export type SupportedEditor = 'vscode' | 'cursor' | 'windsurf' | 'zed' | 'unknown'

export interface EditorDetectionResult {
	editor: SupportedEditor
	source: 'env' | 'none'
}

export interface GitContextResult {
	hasRepository: boolean
	repositoryRoot: string | null
}

export interface MonorepoContextResult {
	isMonorepo: boolean
	root: string | null
	kind: 'pnpm-workspace' | 'npm-workspaces' | 'turborepo' | 'none'
}

export interface EditorWorkspacePresetResult {
	applied: boolean
	filePath: string | null
}

/**
 * Detects which editor is most likely being used by inspecting environment
 * variables commonly set by integrated terminals.
 */
export function detectEditorFromEnvironment(
	env: Record<string, string | undefined> = process.env,
): EditorDetectionResult {
	const termProgram = String(env.TERM_PROGRAM ?? '').toLowerCase()
	const editorValue = `${String(env.EDITOR ?? '')} ${String(env.VISUAL ?? '')}`.toLowerCase()

	if (
		termProgram.includes('cursor') ||
		env.CURSOR_TRACE_ID !== undefined ||
		env.CURSOR_SESSION_ID !== undefined ||
		editorValue.includes('cursor')
	) {
		return { editor: 'cursor', source: 'env' }
	}
	if (
		termProgram.includes('windsurf') ||
		env.WINDSURF_SESSION_ID !== undefined ||
		editorValue.includes('windsurf')
	) {
		return { editor: 'windsurf', source: 'env' }
	}
	if (
		termProgram.includes('vscode') ||
		env.VSCODE_GIT_IPC_HANDLE !== undefined ||
		env.VSCODE_IPC_HOOK !== undefined ||
		env.VSCODE_PID !== undefined ||
		editorValue.includes('code')
	) {
		return { editor: 'vscode', source: 'env' }
	}
	if (termProgram.includes('zed') || env.ZED_TERM !== undefined || editorValue.includes('zed')) {
		return { editor: 'zed', source: 'env' }
	}
	return { editor: 'unknown', source: 'none' }
}

/**
 * Finds the nearest ancestor directory that contains a `.git` entry.
 */
export async function detectGitContext(startDir: string): Promise<GitContextResult> {
	const root = await findNearestAncestorWithEntry(startDir, '.git')
	return {
		hasRepository: root !== null,
		repositoryRoot: root,
	}
}

/**
 * Detects whether the given path is inside a monorepo workspace.
 * Detection currently supports pnpm workspaces, npm workspaces, and Turborepo.
 */
export async function detectMonorepoContext(startDir: string): Promise<MonorepoContextResult> {
	let current = resolve(startDir)
	for (;;) {
		if (await fileExists(join(current, 'pnpm-workspace.yaml'))) {
			return { isMonorepo: true, root: current, kind: 'pnpm-workspace' }
		}

		if (await fileExists(join(current, 'turbo.json'))) {
			return { isMonorepo: true, root: current, kind: 'turborepo' }
		}

		const packageJsonPath = join(current, 'package.json')
		if (await fileExists(packageJsonPath)) {
			try {
				const packageJsonRaw = await readFile(packageJsonPath, 'utf-8')
				const parsed = JSON.parse(packageJsonRaw) as { workspaces?: unknown }
				if (Array.isArray(parsed.workspaces) || isNpmWorkspaceObject(parsed.workspaces)) {
					return { isMonorepo: true, root: current, kind: 'npm-workspaces' }
				}
			} catch {
				// Ignore malformed package.json and keep walking upward.
			}
		}

		const parent = dirname(current)
		if (parent === current) {
			return { isMonorepo: false, root: null, kind: 'none' }
		}
		current = parent
	}
}

/**
 * Applies editor-specific workspace configuration. For VS Code-compatible
 * editors this creates or updates `.vscode/extensions.json` recommendations.
 */
export async function applyEditorWorkspacePreset(params: {
	targetDir: string
	editor: SupportedEditor
}): Promise<EditorWorkspacePresetResult> {
	const { targetDir, editor } = params
	if (editor !== 'vscode' && editor !== 'cursor' && editor !== 'windsurf') {
		return { applied: false, filePath: null }
	}

	const vscodeDir = join(targetDir, '.vscode')
	const extensionsPath = join(vscodeDir, 'extensions.json')
	await mkdir(vscodeDir, { recursive: true })

	const recommendations = ['korajs.kora-devtools']
	const existing = await readJsonObject(extensionsPath)
	const existingRecommendations = Array.isArray(existing?.recommendations)
		? existing.recommendations.filter((item): item is string => typeof item === 'string')
		: []
	const mergedRecommendations = dedupeStrings([...existingRecommendations, ...recommendations])

	const next = {
		recommendations: mergedRecommendations,
	}
	await writeFile(extensionsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
	return { applied: true, filePath: extensionsPath }
}

/**
 * Returns a workspace-aware target directory under the detected monorepo root.
 * This keeps generated apps in conventional package folders.
 */
export function resolveMonorepoTargetDirectory(monorepoRoot: string, projectName: string): string {
	return join(monorepoRoot, 'packages', projectName)
}

function dedupeStrings(values: readonly string[]): string[] {
	return Array.from(new Set(values))
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
	try {
		const content = await readFile(path, 'utf-8')
		const parsed: unknown = JSON.parse(content)
		if (typeof parsed === 'object' && parsed !== null) {
			return parsed as Record<string, unknown>
		}
		return null
	} catch {
		return null
	}
}

function isNpmWorkspaceObject(value: unknown): value is { packages: unknown } {
	if (typeof value !== 'object' || value === null) return false
	const record = value as Record<string, unknown>
	return Array.isArray(record.packages)
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function findNearestAncestorWithEntry(
	startDir: string,
	entryName: string,
): Promise<string | null> {
	let current = resolve(startDir)
	for (;;) {
		const candidate = join(current, entryName)
		try {
			await stat(candidate)
			return current
		} catch {
			// keep walking upward
		}
		const parent = dirname(current)
		if (parent === current) {
			return null
		}
		current = parent
	}
}
