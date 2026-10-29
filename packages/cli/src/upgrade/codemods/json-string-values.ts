import { collectSchemaFields, escapeRegExp } from './schema-fields'
import type { Codemod, CodemodFinding } from './types'

const DOCS = 'https://korajs.dev/guide/upgrading-to-beta13'

/**
 * JSON-encoded strings in `t.json()` / `t.object()` fields.
 *
 * Servers before 1.0.0-beta.13 decoded one JSON-string layer of such values when they built
 * rows; beta.13 stores exactly what the operations wrote. A client that wrote
 * `fields: JSON.stringify([...])` now reads back a string where the old server returned an
 * array or object.
 *
 * Report-only: a string is also a valid json value, so neither this scan nor Kora can tell
 * which stored strings were meant as JSON text. Existing rows are listed by
 * `findJsonStringValues(store)` from `@korajs/server`.
 */
export const jsonStringValuesCodemod: Codemod = {
	id: 'json-field-string-values',
	title: 'json/object fields: values written as JSON strings are no longer decoded by the server',
	introducedIn: '1.0.0-beta.13',
	docs: DOCS,
	run({ files }) {
		const jsonFields = [
			...new Set(
				collectSchemaFields(files)
					.filter((field) => field.type === 'json' || field.type === 'object')
					.map((field) => field.name),
			),
		]
		if (jsonFields.length === 0) return { findings: [], edits: [] }

		const alternatives = jsonFields.map(escapeRegExp).join('|')
		const write = new RegExp(`\\b(${alternatives})\\s*:\\s*JSON\\.stringify\\(`)
		const read = new RegExp(`JSON\\.parse\\(\\s*(?:[\\w$]+[?!]?\\.)*(${alternatives})\\s*\\)`)

		const findings: CodemodFinding[] = []
		for (const file of files) {
			if (!file.text.includes('JSON.')) continue
			for (const [index, line] of file.text.split('\n').entries()) {
				const written = write.exec(line)
				if (written) {
					findings.push({
						file: file.path,
						line: index + 1,
						severity: 'warn',
						message: `"${written[1]}" is a json/object field written as a JSON string. Pass the object or array itself: beta.13 servers store the string as written and no longer decode it. Existing rows: run findJsonStringValues(store) from @korajs/server.`,
					})
					continue
				}
				const parsed = read.exec(line)
				if (parsed) {
					findings.push({
						file: file.path,
						line: index + 1,
						severity: 'info',
						message: `"${parsed[1]}" is a json/object field read with JSON.parse. That only works for rows that hold a JSON string; read the value directly once the writers pass real objects.`,
					})
				}
			}
		}
		return { findings, edits: [] }
	},
}
