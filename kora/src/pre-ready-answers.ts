import type { CollectionDefinition, SchemaDefinition } from '@korajs/core'
import type { CollectionRecord, QueryDescriptor } from '@korajs/store'
import type { ReadAnswer, ReadQuery, ReadRecord } from '@korajs/sync/lite'

/**
 * In-memory answers for queries that run before the store opens (first-visit parity S4b,
 * `docs/design/first-visit-parity.md` 5.4.6).
 *
 * A subscription made before `app.ready` asks the server's read endpoint for its answer and
 * delivers it from memory; the store's own first result replaces it when the store opens. An
 * answer is shown only when the server marked it complete (`ok`): a `partial` or `unsupported`
 * answer is never a result, so those queries render from the store, as without read-through.
 */

/** The longest query key the read endpoint accepts. */
const MAX_QUERY_KEY_LENGTH = 256

/** What an answer source must do: the read client satisfies it, a test double can too. */
export interface AnswerSource {
	read(query: ReadQuery, options?: { signal?: AbortSignal }): Promise<ReadAnswer>
}

/**
 * The read-through query for a descriptor, or null when the query cannot be answered from
 * memory before the store opens.
 *
 * Refused (the store answers instead): relational queries, whose records would need their
 * included rows rebuilt; collections with rich text, whose stored form the in-memory record
 * cannot reproduce; collections the schema does not define; and a descriptor too long to be
 * a key (a hash could collide, and a collision would deliver another query's rows).
 */
export function toReadQuery(
	descriptor: QueryDescriptor,
	schema: SchemaDefinition,
): ReadQuery | null {
	const definition = schema.collections[descriptor.collection]
	if (definition === undefined) return null
	if (descriptor.include !== undefined && descriptor.include.length > 0) return null
	if (hasRichtext(definition)) return null
	const key = JSON.stringify([
		descriptor.collection,
		descriptor.where,
		descriptor.orderBy,
		descriptor.limit ?? null,
		descriptor.offset ?? null,
	])
	if (key.length > MAX_QUERY_KEY_LENGTH) return null
	return {
		key,
		collection: descriptor.collection,
		where: { ...descriptor.where },
		orderBy: descriptor.orderBy.map((entry) => ({
			field: entry.field,
			direction: entry.direction,
		})),
		...(descriptor.limit !== undefined ? { limit: descriptor.limit } : {}),
		...(descriptor.offset !== undefined ? { offset: descriptor.offset } : {}),
	}
}

function hasRichtext(definition: CollectionDefinition): boolean {
	return Object.values(definition.fields).some((field) => field.kind === 'richtext')
}

/**
 * The records a query would return, built from an answer. Fields the answer does not carry
 * read as `null`, as a stored row's empty columns do.
 */
export function recordsFromAnswer(
	records: readonly ReadRecord[],
	definition: CollectionDefinition,
): CollectionRecord[] {
	return records.map((record) => {
		const out: CollectionRecord = {
			id: record.id,
			createdAt: record.created.wallTime,
			updatedAt: record.latest.wallTime,
		}
		for (const field of Object.keys(definition.fields)) {
			const value = record.values[field]
			out[field] = value === undefined ? null : value
		}
		return out
	})
}

/** What the answers need from the app. */
export interface PreReadyAnswersOptions {
	source: AnswerSource
	schema: SchemaDefinition
}

/** Subscription-side callbacks of one pre-ready query. */
export interface PreReadyDelivery {
	/** The complete answer, in the order the query asks for. Called at most once. */
	deliver(records: CollectionRecord[]): void
}

/**
 * Serves in-memory answers to subscriptions made before the store opens. It holds no state
 * between queries: the read client coalesces and shares the requests.
 */
export class PreReadyAnswers {
	constructor(private readonly options: PreReadyAnswersOptions) {}

	/**
	 * Ask for the answer to a query and deliver it when it arrives and is complete.
	 *
	 * @returns A function that withdraws the request; after it (or after the caller took over
	 *   from the store) nothing is delivered. Null when the query cannot be answered this way.
	 */
	subscribe(descriptor: QueryDescriptor, delivery: PreReadyDelivery): (() => void) | null {
		const query = toReadQuery(descriptor, this.options.schema)
		const definition = this.options.schema.collections[descriptor.collection]
		if (query === null || definition === undefined) return null
		const controller = new AbortController()
		let withdrawn = false
		this.options.source.read(query, { signal: controller.signal }).then(
			(answer) => {
				if (withdrawn || answer.result.status !== 'ok') return
				delivery.deliver(recordsFromAnswer(answer.result.records, definition))
			},
			() => {
				// A failed read is not an answer: the store answers when it opens, and the
				// read client has already retried what is worth retrying.
			},
		)
		return () => {
			withdrawn = true
			controller.abort()
		}
	}
}
