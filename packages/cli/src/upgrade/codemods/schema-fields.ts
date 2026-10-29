import type { CodemodContext, SourceFile } from './types'

/**
 * Schema field discovery shared by the schema-aware codemods.
 *
 * A line scanner, not a TypeScript parser: it reads `name: t.json()`-style declarations that
 * sit in a file calling `defineSchema`. A chain split across lines is only seen when the
 * field name and its `t.<type>(` start share a line (the form `kora generate` and every
 * template use). Missing a field makes a codemod quiet, never wrong.
 */

const FIELD_DECLARATION = /\b([A-Za-z_$][\w$]*)\s*:\s*t\.([A-Za-z]+)\(([^\n]*)/g

export interface SchemaField {
	name: string
	/** Builder method: `json`, `object`, `string`, ... */
	type: string
	/** The rest of the declaration line, to look for `.default(`. */
	chain: string
	file: string
	line: number
}

/** Fields declared with `t.*()` in files that call `defineSchema`. */
export function collectSchemaFields(files: CodemodContext['files']): SchemaField[] {
	const fields: SchemaField[] = []
	for (const file of files) {
		if (!file.text.includes('defineSchema')) continue
		fields.push(...fieldsOfFile(file))
	}
	return fields
}

function fieldsOfFile(file: SourceFile): SchemaField[] {
	const found: SchemaField[] = []
	for (const [index, line] of file.text.split('\n').entries()) {
		FIELD_DECLARATION.lastIndex = 0
		for (let match = FIELD_DECLARATION.exec(line); match; match = FIELD_DECLARATION.exec(line)) {
			const [, name, type, chain] = match
			if (name && type) {
				found.push({ name, type, chain: chain ?? '', file: file.path, line: index + 1 })
			}
		}
	}
	return found
}

/** Escapes text for use inside a RegExp. */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
