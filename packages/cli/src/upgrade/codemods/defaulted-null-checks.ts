import { collectSchemaFields, escapeRegExp } from './schema-fields'
import type { Codemod, CodemodFinding } from './types'

const DOCS = 'https://korajs.dev/docs/guide/upgrading-to-beta13'

/**
 * Nullable default normalization (RT-106, 1.0.0-beta.13).
 *
 * Records written before a schema upgrade added a field with a default used to read `null`
 * on the server (absent on the memory store) and the default on every device. Server stores
 * now materialize a field the record's operations never wrote as its schema default, like the
 * devices do. Code that tests such a field against `null` (or falls back with `??`) to detect
 * "never set" no longer sees `null` on the server.
 *
 * Report-only: whether the check meant "never set" or "explicitly cleared" is the author's
 * intent, and the same property name may belong to an unrelated object. Findings are
 * `info` for that reason.
 */
export const defaultedNullChecksCodemod: Codemod = {
	id: 'defaulted-field-null-checks',
	title: 'Fields with a default now read their default on the server, never null',
	introducedIn: '1.0.0-beta.13',
	docs: DOCS,
	run({ files }) {
		const defaulted = [
			...new Set(
				collectSchemaFields(files)
					.filter((field) => field.chain.includes('.default('))
					.map((field) => field.name),
			),
		]
		if (defaulted.length === 0) return { findings: [], edits: [] }

		const alternatives = defaulted.map(escapeRegExp).join('|')
		const afterProperty = new RegExp(`\\.(${alternatives})\\s*(?:[!=]==?\\s*null\\b|\\?\\?)`)
		const beforeProperty = new RegExp(`\\bnull\\s*[!=]==?\\s*[\\w$.?]*\\.(${alternatives})\\b`)

		const findings: CodemodFinding[] = []
		for (const file of files) {
			for (const [index, line] of file.text.split('\n').entries()) {
				if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue
				const match = afterProperty.exec(line) ?? beforeProperty.exec(line)
				if (match) {
					findings.push({
						file: file.path,
						line: index + 1,
						severity: 'info',
						message: `"${match[1]}" has a schema default. Records written before the field existed now read that default on the server too (they read null before beta.13); check this null test still means what you intend.`,
					})
				}
			}
		}
		return { findings, edits: [] }
	},
}
