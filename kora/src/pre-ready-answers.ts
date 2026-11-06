import type { CollectionDefinition, SchemaDefinition } from '@korajs/core'
import type { CollectionRecord, QueryDescriptor, SeedInput, SeedMeta, Store } from '@korajs/store'
import type { ReadAnswer, ReadQuery, ReadRecord } from '@korajs/sync/read'

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

/**
 * What a delivered answer leaves behind for the store: the rows as seeds, so the store's own
 * first result for the query is the answer already on screen instead of an empty one.
 */
export interface AnswerHandoff {
	inputs: SeedInput[]
	meta: SeedMeta
}

/** Subscription-side callbacks of one pre-ready query. */
export interface PreReadyDelivery {
	/**
	 * The complete answer, in the order the query asks for, and the seeds that carry it into
	 * the store. Called at most once.
	 */
	deliver(records: CollectionRecord[], handoff: AnswerHandoff): void
}

/** The seeds of an answer's rows. */
export function handoffFromAnswer(
	collection: string,
	records: readonly ReadRecord[],
	meta: SeedMeta,
): AnswerHandoff {
	return {
		inputs: records.map((record) => ({
			collection,
			id: record.id,
			values: record.values,
			fieldVersions: record.fieldVersions,
			created: record.created,
			latest: record.latest,
		})),
		meta,
	}
}

/**
 * Serves in-memory answers to subscriptions made before the store opens. It holds no state
 * between queries: the read client coalesces and shares the requests.
 */
export class PreReadyAnswers {
	constructor(private readonly options: PreReadyAnswersOptions) {}

	/** Seed delivered answers into the open store. See {@link seedHandoffs}. */
	seed(
		store: Store,
		handoffs: readonly AnswerHandoff[],
		report: (code: string, message: string) => void,
	): Promise<void> {
		return seedHandoffs(store, handoffs, report)
	}

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
				delivery.deliver(
					recordsFromAnswer(answer.result.records, definition),
					handoffFromAnswer(descriptor.collection, answer.result.records, {
						frontier: answer.frontier,
						grantKey: answer.grantKey,
					}),
				)
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

/**
 * The handoffs to seed, each with only the records for which it is the newest answer: two
 * queries over one collection can both return a record, and the later read must not be
 * overwritten by the earlier one.
 */
function newestPerRecord(handoffs: readonly AnswerHandoff[]): Array<[AnswerHandoff, SeedInput[]]> {
	const winner = new Map<string, AnswerHandoff>()
	for (const handoff of handoffs) {
		for (const input of handoff.inputs) {
			const key = `${input.collection}\u0000${input.id}`
			const current = winner.get(key)
			if (current === undefined || handoff.meta.frontier > current.meta.frontier) {
				winner.set(key, handoff)
			}
		}
	}
	return handoffs.map((handoff) => [
		handoff,
		handoff.inputs.filter(
			(input) => winner.get(`${input.collection}\u0000${input.id}`) === handoff,
		),
	])
}

/**
 * Seed answers into the store, one handoff at a time. A record the store has history for is
 * left to the store; any other skip, and any failure, goes to `report`.
 */
async function seedHandoffs(
	store: Store,
	handoffs: readonly AnswerHandoff[],
	report: (code: string, message: string) => void,
): Promise<void> {
	try {
		for (const [handoff, inputs] of newestPerRecord(handoffs)) {
			const outcome = await store.seedRecords(inputs, handoff.meta)
			const unexpected = outcome.skipped.filter(
				(skip) => skip.reason !== 'has-history' && skip.reason !== 'not-newer',
			)
			if (unexpected.length > 0) {
				report(
					'READ_SEED_SKIPPED',
					`${unexpected.length} record(s) of a read-through answer were not seeded (${[
						...new Set(unexpected.map((skip) => skip.reason)),
					].join(', ')}); their queries show the store's rows.`,
				)
			}
		}
	} catch (error) {
		report(
			'READ_SEED_FAILED',
			`A read-through answer could not be seeded: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}
