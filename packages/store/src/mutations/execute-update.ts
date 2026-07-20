import type { AtomicOp } from '@korajs/core'
import {
	createOperation,
	isAtomicOp,
	resolveAtomicOp,
	toAtomicOp,
	validateRecord,
} from '@korajs/core'
import { RecordNotFoundError } from '../errors'
import { parseFieldVersions, serializeFieldVersions } from '../lww/field-versions'
import { serializeRowVersion } from '../lww/row-version'
import { buildInsertQuery, buildUpdateQuery } from '../query/sql-builder'
import { encodeRichtextFieldsForOpData } from '../serialization/op-data-encoding'
import { deserializeRecord, serializeOperation, serializeRecord } from '../serialization/serializer'
import { validateUpdateStateMachine } from '../state-machine/state-validator'
import { allocateNextSequenceInTransaction } from '../store/sequence-allocator'
import type { CollectionRecord, RawCollectionRow } from '../types'
import { resolveCausalDeps } from './resolve-causal-deps'
import type { LocalMutationContext } from './types'

/**
 * Update a record and persist the operation log entry atomically.
 */
export async function executeUpdate(
	ctx: LocalMutationContext,
	id: string,
	data: Record<string, unknown>,
): Promise<CollectionRecord> {
	const currentRows = await ctx.adapter.query<RawCollectionRow>(
		`SELECT * FROM ${ctx.collection} WHERE id = ? AND _deleted = 0`,
		[id],
	)
	const currentRow = currentRows[0]
	if (!currentRow) {
		throw new RecordNotFoundError(ctx.collection, id)
	}

	let validated = validateRecord(ctx.collection, ctx.definition, data, 'update')
	const currentRecord = deserializeRecord(currentRow, ctx.definition.fields)
	validated = validateUpdateStateMachine(
		ctx.collection,
		id,
		ctx.definition,
		currentRecord,
		validated,
	)

	if (Object.keys(validated).length === 0) {
		return { ...currentRecord }
	}

	const previousData: Record<string, unknown> = {}
	const resolvedData: Record<string, unknown> = {}
	const atomicOps: Record<string, AtomicOp> = {}

	for (const key of Object.keys(validated)) {
		const value = validated[key]
		previousData[key] = currentRecord[key]

		if (isAtomicOp(value)) {
			resolvedData[key] = resolveAtomicOp(currentRecord[key], value)
			atomicOps[key] = toAtomicOp(value)
		} else {
			resolvedData[key] = value
		}
	}

	const hasAtomicOps = Object.keys(atomicOps).length > 0
	const causalDeps = resolveCausalDeps(ctx)
	let operation!: Awaited<ReturnType<typeof createOperation>>

	await ctx.adapter.transaction(async (tx) => {
		const sequenceNumber = await allocateNextSequenceInTransaction(tx, ctx.nodeId)
		operation = await createOperation(
			{
				nodeId: ctx.nodeId,
				type: 'update',
				collection: ctx.collection,
				recordId: id,
				// Binary richtext values (new and previous) are tagged as canonical
				// JSON BEFORE the operation is content-hashed, so the hash input,
				// persisted JSON, and wire payload are the identical value.
				data: encodeRichtextFieldsForOpData(resolvedData, ctx.definition.fields),
				previousData: encodeRichtextFieldsForOpData(previousData, ctx.definition.fields),
				sequenceNumber,
				causalDeps,
				schemaVersion: ctx.schema.version,
				...(hasAtomicOps ? { atomicOps } : {}),
			},
			ctx.clock,
		)
		ctx.causalTracker?.afterOperation(ctx.collection, operation.id, ctx.inTransaction)

		const serializedChanges = serializeRecord(resolvedData, ctx.definition.fields)
		const version = serializeRowVersion(operation.timestamp)
		// A local edit is always the newest writer of the fields it touches (the
		// HLC advances past every timestamp this device has seen), so stamp each
		// changed field with this operation's version.
		const mergedFieldVersions = parseFieldVersions(currentRow._field_versions)
		for (const changedField of Object.keys(serializedChanges)) {
			mergedFieldVersions[changedField] = version
		}
		const updateQuery = buildUpdateQuery(ctx.collection, id, {
			...serializedChanges,
			_updated_at: operation.timestamp.wallTime,
			_version: version,
			_field_versions: serializeFieldVersions(mergedFieldVersions),
		})
		const opInsert = buildInsertQuery(
			`_kora_ops_${ctx.collection}`,
			serializeOperation(operation) as unknown as Record<string, unknown>,
		)

		await tx.execute(updateQuery.sql, updateQuery.params)
		await tx.execute(opInsert.sql, opInsert.params)
	})

	ctx.onMutation(ctx.collection, operation)

	const rows = await ctx.adapter.query<RawCollectionRow>(
		`SELECT * FROM ${ctx.collection} WHERE id = ? AND _deleted = 0`,
		[id],
	)
	const row = rows[0]
	if (!row) {
		throw new RecordNotFoundError(ctx.collection, id)
	}
	return deserializeRecord(row, ctx.definition.fields)
}
