import { KoraError } from '@korajs/core'
import type { ServerStore } from '../store/server-store'

/** {@link findJsonStringValues} was given a page or sample size it cannot use. */
export class InvalidDiagnosticOptionsError extends KoraError {
	constructor(option: string, value: unknown) {
		super(
			`findJsonStringValues: ${option} must be a ${option === 'pageSize' ? 'positive' : 'non-negative'} integer, got ${String(value)}.`,
			'INVALID_DIAGNOSTIC_OPTIONS',
			{ option, value },
		)
		this.name = 'InvalidDiagnosticOptionsError'
	}
}

/** Rows of one json/object field whose stored value is a string that itself holds JSON. */
export interface JsonStringValueReport {
	collection: string
	field: string
	/** How many live rows hold such a string. */
	count: number
	/** Ids of the first such rows, to inspect. */
	sampleIds: string[]
}

/** Options for {@link findJsonStringValues}. */
export interface FindJsonStringValuesOptions {
	/** Ids reported per field. Defaults to 10. */
	sampleSize?: number
	/** Rows read per page. Defaults to 1,000. */
	pageSize?: number
}

/**
 * Find `t.json()` / `t.object()` fields whose stored value is a JSON-encoded string
 * (`'{"a":1}'` instead of `{ a: 1 }`), after an upgrade from a server older than
 * 1.0.0-beta.13 (F14).
 *
 * Servers before beta.13 decoded one JSON-string layer of such values when they built
 * rows; since beta.13 the rows hold exactly what the operations wrote. A client that
 * wrote a json field as a string (or double-encoded it) therefore reads back a string
 * where the old server returned an object. Kora does not rewrite these values: a string
 * is also a legitimate json value, so no rule can tell a real string from an encoded
 * object. Fix them with server-authored updates (`server.kora.apply`) once you know
 * which shape your app expects.
 *
 * @param store - The server store, with its schema set
 * @param options - Sample and page sizes
 * @returns One report per field that holds at least one such value
 * @throws {InvalidDiagnosticOptionsError} When `pageSize` is not a positive integer or
 *   `sampleSize` not a non-negative one
 *
 * @example
 * ```typescript
 * for (const report of await findJsonStringValues(store)) {
 *   console.warn(`${report.collection}.${report.field}: ${report.count} rows`, report.sampleIds)
 * }
 * ```
 */
export async function findJsonStringValues(
	store: ServerStore,
	options: FindJsonStringValuesOptions = {},
): Promise<JsonStringValueReport[]> {
	const schema = store.getSchema()
	if (!schema) return []
	const sampleSize = options.sampleSize ?? 10
	const pageSize = options.pageSize ?? 1_000
	// A page size of 0 would never advance the offset (an endless loop).
	if (!Number.isInteger(pageSize) || pageSize < 1) {
		throw new InvalidDiagnosticOptionsError('pageSize', pageSize)
	}
	if (!Number.isInteger(sampleSize) || sampleSize < 0) {
		throw new InvalidDiagnosticOptionsError('sampleSize', sampleSize)
	}
	const reports: JsonStringValueReport[] = []
	for (const [collection, definition] of Object.entries(schema.collections)) {
		const fields = Object.entries(definition.fields)
			.filter(([, descriptor]) => descriptor.kind === 'json' || descriptor.kind === 'object')
			.map(([name]) => name)
		if (fields.length === 0) continue
		const found = new Map<string, JsonStringValueReport>()
		for (let offset = 0; ; offset += pageSize) {
			const rows = await store.queryCollection(collection, {
				orderBy: 'id',
				limit: pageSize,
				offset,
			})
			for (const row of rows) {
				for (const field of fields) {
					if (!isEncodedJson(row[field])) continue
					let report = found.get(field)
					if (!report) {
						report = { collection, field, count: 0, sampleIds: [] }
						found.set(field, report)
					}
					report.count += 1
					if (report.sampleIds.length < sampleSize) report.sampleIds.push(String(row.id))
				}
			}
			if (rows.length < pageSize) break
		}
		reports.push(...found.values())
	}
	return reports
}

/** A string whose content parses as a JSON object, array or string (one encoded layer). */
function isEncodedJson(value: unknown): boolean {
	if (typeof value !== 'string') return false
	const trimmed = value.trim()
	const first = trimmed[0]
	if (first !== '{' && first !== '[' && first !== '"') return false
	try {
		JSON.parse(trimmed)
		return true
	} catch {
		return false
	}
}
