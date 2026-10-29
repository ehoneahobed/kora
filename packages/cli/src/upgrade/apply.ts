import { readFile, writeFile } from 'node:fs/promises'
import { UpgradeError } from '../errors'
import type { PlannedChange } from './plan'
import { rewriteYamlSpecLine } from './project'

/**
 * Writes the planned specifier changes to package.json and pnpm-workspace.yaml.
 *
 * Only the version string changes: every other byte of the file (indentation, inline arrays,
 * key order, duplicate keys, CRLF, a byte-order mark) is kept as it was. A specifier that cannot
 * be located exactly once is refused with an error instead of guessed at. Lockfiles and
 * node_modules are never opened: the package manager's install does that.
 */

interface StringSpan {
	/** Offset of the opening quote. */
	start: number
	/** Offset just past the closing quote. */
	end: number
}

/**
 * Finds every string value stored at `path` + `name` in JSON text, with its source span.
 * A small scanner over the text (not a re-serializer), so a duplicate key yields several
 * spans and the caller can refuse. Returns null if the text is not parseable JSON.
 */
export function findJsonStringSpans(
	text: string,
	path: string[],
	name: string,
): StringSpan[] | null {
	const target = [...path, name]
	const spans: StringSpan[] = []
	let i = text.charCodeAt(0) === 0xfeff ? 1 : 0

	const skipSpace = (): void => {
		while (i < text.length && /\s/.test(text[i] ?? '')) i++
	}
	const readString = (): StringSpan | null => {
		if (text[i] !== '"') return null
		const start = i
		i++
		while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
		if (i >= text.length) return null
		i++
		return { start, end: i }
	}
	const matches = (stack: string[]): boolean =>
		stack.length === target.length && stack.every((key, index) => key === target[index])

	const readValue = (stack: string[]): boolean => {
		skipSpace()
		const char = text[i]
		if (char === '{') {
			i++
			skipSpace()
			if (text[i] === '}') {
				i++
				return true
			}
			for (;;) {
				skipSpace()
				const key = readString()
				if (!key) return false
				let decoded: unknown
				try {
					decoded = JSON.parse(text.slice(key.start, key.end))
				} catch {
					return false
				}
				skipSpace()
				if (text[i] !== ':') return false
				i++
				skipSpace()
				const next = [...stack, String(decoded)]
				if (text[i] === '"') {
					const value = readString()
					if (!value) return false
					if (matches(next)) spans.push(value)
				} else if (!readValue(next)) {
					return false
				}
				skipSpace()
				if (text[i] === ',') {
					i++
					continue
				}
				if (text[i] === '}') {
					i++
					return true
				}
				return false
			}
		}
		if (char === '[') {
			i++
			skipSpace()
			if (text[i] === ']') {
				i++
				return true
			}
			for (let index = 0; ; index++) {
				if (!readValue([...stack, `[${index}]`])) return false
				skipSpace()
				if (text[i] === ',') {
					i++
					continue
				}
				if (text[i] === ']') {
					i++
					return true
				}
				return false
			}
		}
		if (char === '"') return readString() !== null
		const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i))
		if (!literal) return false
		i += literal[0].length
		return true
	}

	if (!readValue([])) return null
	skipSpace()
	return i === text.length ? spans : null
}

/**
 * Returns package.json text with the given specifiers rewritten in place.
 *
 * @throws UpgradeError when a specifier is not present exactly once with its recorded value
 */
export function rewritePackageJson(
	text: string,
	changes: PlannedChange[],
	file = 'package.json',
): string {
	const edits: Array<{ start: number; end: number; replacement: string }> = []
	for (const change of changes) {
		const specifier = change.specifier
		if (specifier.format !== 'package-json') continue
		const spans = findJsonStringSpans(text, specifier.path, specifier.name)
		const only = spans?.length === 1 ? spans[0] : undefined
		const current = only ? (JSON.parse(text.slice(only.start, only.end)) as unknown) : undefined
		if (!only || current !== specifier.spec) {
			throw new UpgradeError(
				`Cannot update ${specifier.name} in ${file} (${specifier.section}): ${
					spans === null
						? 'the file is not valid JSON'
						: spans.length > 1
							? 'the key appears more than once'
							: 'it changed since it was read'
				}. Edit it by hand to ${change.to}.`,
				'UPGRADE_CANNOT_LOCATE_SPECIFIER',
				{ file, name: specifier.name, section: specifier.section },
			)
		}
		edits.push({ start: only.start, end: only.end, replacement: JSON.stringify(change.to) })
	}
	let result = text
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
	}
	return result
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
 * Applies every change to its file and returns the absolute paths written, in a stable order.
 * Every file is rewritten in memory first, so a specifier that cannot be located aborts before
 * any write. If a write fails, the files already written are restored from the originals held
 * in memory and an {@link UpgradeError} is thrown.
 */
export async function applyUpgradeChanges(changes: PlannedChange[]): Promise<string[]> {
	const byFile = new Map<string, PlannedChange[]>()
	for (const change of changes) {
		const list = byFile.get(change.specifier.file) ?? []
		list.push(change)
		byFile.set(change.specifier.file, list)
	}

	const pending: Array<{ file: string; original: string; updated: string }> = []
	for (const file of [...byFile.keys()].sort()) {
		const fileChanges = byFile.get(file) ?? []
		const original = await readFile(file, 'utf-8')
		const isYaml = fileChanges.some((change) => change.specifier.format === 'pnpm-workspace')
		pending.push({
			file,
			original,
			updated: isYaml
				? rewriteWorkspaceYaml(original, fileChanges)
				: rewritePackageJson(original, fileChanges, file),
		})
	}

	const written: Array<{ file: string; original: string }> = []
	try {
		for (const entry of pending) {
			// Recorded first: a write that fails halfway must be restored as well.
			written.push(entry)
			await writeFile(entry.file, entry.updated, 'utf-8')
		}
	} catch (error) {
		const failed: string[] = []
		for (const entry of written.reverse()) {
			try {
				await writeFile(entry.file, entry.original, 'utf-8')
			} catch {
				failed.push(entry.file)
			}
		}
		throw new UpgradeError(
			`Writing the upgrade failed (${error instanceof Error ? error.message : String(error)}). ${
				failed.length > 0
					? `These files could not be restored, check them with git: ${failed.join(', ')}.`
					: 'Files already written were restored.'
			}`,
			'UPGRADE_WRITE_FAILED',
			{ unrestored: failed },
		)
	}
	return pending.map((entry) => entry.file)
}
