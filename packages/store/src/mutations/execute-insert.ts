import { createOperation, generateUUIDv7, validateRecord } from '@korajs/core'
import { fieldVersionsForFields, serializeFieldVersions } from '../lww/field-versions'
import { serializeRowVersion } from '../lww/row-version'
import { buildInsertQuery } from '../query/sql-builder'
import { encodeRichtextFieldsForOpData } from '../serialization/op-data-encoding'
import { serializeOperation, serializeRecord } from '../serialization/serializer'
import { allocateNextSequenceInTransaction } from '../store/sequence-allocator'
import type { CollectionRecord } from '../types'
import { resolveCausalDeps } from './resolve-causal-deps'
import type { LocalMutationContext } from './types'

/**
 * Insert a record and persist the operation log entry atomically.
 */
export async function executeInsert(
	ctx: LocalMutationContext,
	data: Record<string, unknown>,
): Promise<CollectionRecord> {
	const validated = validateRecord(ctx.collection, ctx.definition, data, 'insert')
	const recordId = generateUUIDv7()

	for (const [fieldName, descriptor] of Object.entries(ctx.definition.fields)) {
		if (descriptor.auto && descriptor.kind === 'timestamp') {
			validated[fieldName] = Date.now()
		}
	}

	const causalDeps = resolveCausalDeps(ctx)

	let operation!: Awaited<ReturnType<typeof createOperation>>
	let record!: Record<string, unknown>

	await ctx.adapter.transaction(async (tx) => {
		const sequenceNumber = await allocateNextSequenceInTransaction(tx, ctx.nodeId)
		operation = await createOperation(
			{
				nodeId: ctx.nodeId,
				type: 'insert',
				collection: ctx.collection,
				recordId,
				// Binary richtext values are tagged as canonical JSON BEFORE the
				// operation is content-hashed, so the hash input, persisted JSON,
				// and wire payload are the identical value.
				data: encodeRichtextFieldsForOpData(validated, ctx.definition.fields),
				previousData: null,
				sequenceNumber,
				causalDeps,
				schemaVersion: ctx.schema.version,
			},
			ctx.clock,
		)
		ctx.causalTracker?.afterOperation(ctx.collection, operation.id, ctx.inTransaction)

		const serializedData = serializeRecord(validated, ctx.definition.fields)
		const version = serializeRowVersion(operation.timestamp)
		record = {
			id: recordId,
			...serializedData,
			_created_at: operation.timestamp.wallTime,
			_updated_at: operation.timestamp.wallTime,
			_version: version,
			// Stamp every inserted field with this operation's version so later
			// per-field LWW compares against a real writer, not the fallback.
			_field_versions: serializeFieldVersions(
				fieldVersionsForFields(Object.keys(serializedData), version),
			),
		}

		const builtInsert = buildInsertQuery(ctx.collection, record)
		const opInsert = buildInsertQuery(
			`_kora_ops_${ctx.collection}`,
			serializeOperation(operation) as unknown as Record<string, unknown>,
		)

		await tx.execute(builtInsert.sql, builtInsert.params)
		await tx.execute(opInsert.sql, opInsert.params)
	})

	ctx.onMutation(ctx.collection, operation)

	return {
		id: recordId,
		...validated,
		createdAt: operation.timestamp.wallTime,
		updatedAt: operation.timestamp.wallTime,
	}
}
