import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareVersions, parseVersion } from '../semver'
import { defaultedNullChecksCodemod } from './defaulted-null-checks'
import { jsonStringValuesCodemod } from './json-string-values'
import { protobufSerializerCodemod } from './protobuf-serializer'
import type { Codemod, CodemodContext, CodemodEdit, CodemodFinding, SourceFile } from './types'

/**
 * Every codemod `kora upgrade` knows, in the order their findings are printed. Add new ones
 * here (see `types.ts` for the interface and the rules a codemod follows).
 */
export const CODEMODS: readonly Codemod[] = [
	protobufSerializerCodemod,
	jsonStringValuesCodemod,
	defaultedNullChecksCodemod,
]

/**
 * True when an upgrade from `fromVersion` to `toVersion` crosses the release that introduced
 * the codemod's change. An unknown `fromVersion` runs everything up to the target: a false
 * report costs a glance, a missed one costs data.
 */
export function codemodApplies(
	codemod: Codemod,
	fromVersion: string | null,
	toVersion: string,
): boolean {
	if (!parseVersion(codemod.introducedIn)) return false
	if (compareVersions(codemod.introducedIn, toVersion) > 0) return false
	return fromVersion === null || compareVersions(fromVersion, codemod.introducedIn) < 0
}

export interface CodemodRunSummary {
	codemod: Codemod
	findings: CodemodFinding[]
	edits: CodemodEdit[]
}

/** Runs the applicable codemods over the files. Read-only. */
export function runCodemods(
	context: CodemodContext,
	codemods: readonly Codemod[] = CODEMODS,
): CodemodRunSummary[] {
	return codemods
		.filter((codemod) => codemodApplies(codemod, context.fromVersion, context.toVersion))
		.map((codemod) => {
			const result = codemod.run(context)
			return { codemod, findings: result.findings, edits: result.edits }
		})
}

/**
 * Applies codemod edits to the files on disk. Edits to one file are applied from the end so
 * earlier offsets stay valid. A file with overlapping edits, or one that changed on disk since
 * the scan, is left untouched and reported in `skipped`.
 */
export async function applyCodemodEdits(
	projectRoot: string,
	files: SourceFile[],
	edits: CodemodEdit[],
): Promise<{ written: string[]; skipped: string[] }> {
	const byFile = new Map<string, CodemodEdit[]>()
	for (const edit of edits) {
		const list = byFile.get(edit.file) ?? []
		list.push(edit)
		byFile.set(edit.file, list)
	}
	const written: string[] = []
	const skipped: string[] = []
	for (const [path, fileEdits] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const source = files.find((file) => file.path === path)
		if (!source) {
			skipped.push(path)
			continue
		}
		const ordered = [...fileEdits].sort((a, b) => b.start - a.start)
		const overlapping = ordered.some((edit, i) => {
			const next = ordered[i + 1]
			return next !== undefined && next.end > edit.start
		})
		if (overlapping) {
			skipped.push(path)
			continue
		}
		let text = source.text
		for (const edit of ordered) {
			text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
		}
		const absolute = join(projectRoot, path)
		// Re-read so a file edited since the scan is never overwritten with stale text.
		if ((await readFile(absolute, 'utf-8')) !== source.text) {
			skipped.push(path)
			continue
		}
		await writeFile(absolute, text, 'utf-8')
		written.push(path)
	}
	return { written, skipped }
}
