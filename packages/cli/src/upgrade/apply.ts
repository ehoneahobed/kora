import { readFile, writeFile } from 'node:fs/promises'
import type { PlannedChange } from './plan'
import { rewriteYamlSpecLine } from './project'

/**
 * Writes the planned specifier changes to package.json and pnpm-workspace.yaml.
 *
 * Only the version text changes. package.json keeps its indentation, key order and trailing
 * newline; the YAML keeps quoting and comments. Lockfiles and node_modules are never opened:
 * the package manager's install does that.
 */

function detectIndent(text: string): string | number {
	const match = /^([ \t]+)"/m.exec(text)
	return match?.[1] ?? 2
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Returns package.json text with the given specifiers rewritten. */
export function rewritePackageJson(text: string, changes: PlannedChange[]): string {
	const parsed: unknown = JSON.parse(text)
	if (!isRecord(parsed)) return text
	for (const change of changes) {
		const specifier = change.specifier
		if (specifier.format !== 'package-json') continue
		let node: unknown = parsed
		for (const key of specifier.path) {
			node = isRecord(node) ? node[key] : undefined
		}
		if (isRecord(node) && node[specifier.name] === specifier.spec) {
			node[specifier.name] = change.to
		}
	}
	const eol = text.includes('\r\n') ? '\r\n' : '\n'
	const body = JSON.stringify(parsed, null, detectIndent(text)).replace(/\n/g, eol)
	return /\r?\n$/.test(text) ? `${body}${eol}` : body
}

/** Returns pnpm-workspace.yaml text with the given catalog/override lines rewritten. */
export function rewriteWorkspaceYaml(text: string, changes: PlannedChange[]): string {
	const lines = text.split('\n')
	for (const change of changes) {
		const specifier = change.specifier
		if (specifier.format !== 'pnpm-workspace') continue
		const original = lines[specifier.line]
		if (original === undefined) continue
		// Lines keep their own "\r" when the file uses CRLF; rewrite only the visible part.
		const carriage = original.endsWith('\r') ? '\r' : ''
		lines[specifier.line] =
			`${rewriteYamlSpecLine(original.replace(/\r$/, ''), change.to)}${carriage}`
	}
	return lines.join('\n')
}

/**
 * Applies every change to its file. Returns the absolute paths written, in a stable order.
 * Every file is rewritten in memory first, so a malformed file aborts before any write.
 */
export async function applyUpgradeChanges(changes: PlannedChange[]): Promise<string[]> {
	const byFile = new Map<string, PlannedChange[]>()
	for (const change of changes) {
		const list = byFile.get(change.specifier.file) ?? []
		list.push(change)
		byFile.set(change.specifier.file, list)
	}

	const rewritten: Array<[string, string]> = []
	for (const file of [...byFile.keys()].sort()) {
		const fileChanges = byFile.get(file) ?? []
		const text = await readFile(file, 'utf-8')
		const isYaml = fileChanges.some((change) => change.specifier.format === 'pnpm-workspace')
		rewritten.push([
			file,
			isYaml ? rewriteWorkspaceYaml(text, fileChanges) : rewritePackageJson(text, fileChanges),
		])
	}
	for (const [file, content] of rewritten) {
		await writeFile(file, content, 'utf-8')
	}
	return rewritten.map(([file]) => file)
}
