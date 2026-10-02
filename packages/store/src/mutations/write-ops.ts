import type { AtomicOp, CollectionDefinition, Operation } from '@korajs/core'
import {
	KoraError,
	createOperation,
	generateUUIDv7,
	isAtomicOp,
	quoteIdent,
	resolveAtomicOp,
	toAtomicOp,
	validateRecord,
} from '@korajs/core'
import { RecordNotFoundError } from '../errors'
import { stampFieldVersions } from '../lww/field-versions'
import { serializeRowVersion } from '../lww/row-version'
import { buildInsertQuery, buildSoftDeleteQuery, buildUpdateQuery } from '../query/sql-builder'
import { encodeRichtextFieldsForOpData } from '../serialization/op-data-encoding'
import { deserializeRecord, serializeOperation, serializeRecord } from '../serialization/serializer'
import { validateUpdateStateMachine } from '../state-machine/state-validator'
import type { CollectionRecord, RawCollectionRow } from '../types'
import { toAtRestWriteData } from './secret-write'
import type { WriteEnv, WriteScope } from './write-context'

/*
 * THE local write path (W6). Every local operation — a single-record write, each
 * entry of an `app.transaction` / `app.mutation` commit, and every referential
 * cascade — is built and persisted by the functions in this file, inside the
 * storage transaction that commits it:
 *
 * 1. the current row is read through the transaction handle, so validation
 *    (existence, state machine) and atomic ops resolve against committed state;
 * 2. the sequence number comes from the transaction's SequenceBlock (reserved
 *    with UPSERT ... RETURNING on `_kora_version_vector` inside the transaction,
 *    end persisted before commit); transactions are serialized, so the numbers of
 *    one commit form one contiguous block and two commits can never share one;
 * 3. the operation is built only AFTER its sequence number is reserved, and is
 *    never re-stamped (protocol v2 hashes the sequence number into the id);
 * 4. the row is written with per-field version stamps and the operation row is
 *    appended, in the same transaction.
 */

/** An insert whose values are validated and in their at-rest form. */
export interface PreparedInsert {
	readonly collection: string
	readonly recordId: string
	/** Record-shaped, at-rest values (secret fields hashed / encrypted). */
	readonly data: Record<string, unknown>
}

/**
 * Validate insert data, fill auto fields and transform secrets. Pure with
 * respect to storage, so `app.transaction` can do it when the developer calls
 * `insert` (returning the new id immediately) and write it at commit.
 */
export async function prepareInsert(
	env: WriteEnv,
	collection: string,
	data: Record<string, unknown>,
): Promise<PreparedInsert> {
	const definition = requireDefinition(env, collection)
	const validated = validateRecord(collection, definition, data, 'insert')
	const now = Date.now()
	for (const [fieldName, descriptor] of Object.entries(definition.fields)) {
		if (descriptor.auto && descriptor.kind === 'timestamp') {
			validated[fieldName] = now
		}
	}
	// Secret fields reach their at-rest form BEFORE the operation is built, so
	// plaintext never enters the op log, the row, or the wire (STORE-4).
	const writeData = await toAtRestWriteData(validated, definition, env.secretKeyProvider)
	return { collection, recordId: generateUUIDv7(), data: writeData }
}

/** Result of writing one local operation. */
export interface WriteResult {
	/** The operation, or null when the write turned out to be a no-op. */
	readonly operation: Operation | null
	/** The record as stored after the write. */
	readonly record: CollectionRecord
	/** Operations created as side effects (referential cascades), in creation order. */
	readonly sideEffects: Operation[]
}

/**
 * Write a prepared insert inside `scope.tx`.
 */
export async function writeInsertInTx(
	env: WriteEnv,
	scope: WriteScope,
	insert: PreparedInsert,
	extraCausalDeps: readonly string[] = [],
): Promise<WriteResult> {
	const definition = requireDefinition(env, insert.collection)
	const operation = await buildLocalOperation(env, scope, {
		type: 'insert',
		collection: insert.collection,
		recordId: insert.recordId,
		// Binary richtext values are tagged as canonical JSON BEFORE hashing, so the
		// hash input, persisted JSON and wire payload are the identical value.
		data: encodeRichtextFieldsForOpData(insert.data, definition.fields),
		previousData: null,
		extraCausalDeps,
	})

	if (env.fold) {
		// Append, then merge: the row is the materialization of the record's state.
		await appendOperationRow(scope, operation)
		await env.fold.applyInTx(scope.tx, operation, 'local')
	} else {
		const serialized = serializeRecord(insert.data, definition.fields)
		const version = serializeRowVersion(operation.timestamp)
		const row: Record<string, unknown> = {
			id: insert.recordId,
			...serialized,
			_created_at: operation.timestamp.wallTime,
			_updated_at: operation.timestamp.wallTime,
			_version: version,
			// Every inserted field is stamped with this operation's version, so later
			// per-field LWW compares against a real writer, not the row fallback.
			_field_versions: stampFieldVersions(null, Object.keys(serialized), version),
		}
		const rowInsert = buildInsertQuery(insert.collection, row)
		await scope.tx.execute(rowInsert.sql, rowInsert.params)
		await appendOperationRow(scope, operation)
	}

	return {
		operation,
		record: {
			id: insert.recordId,
			...insert.data,
			createdAt: operation.timestamp.wallTime,
			updatedAt: operation.timestamp.wallTime,
		},
		sideEffects: [],
	}
}

/**
 * Write a local update inside `scope.tx`.
 *
 * `data` must already be schema-validated (it may contain atomic op descriptors).
 * The state machine, atomic ops and `previousData` are all resolved against the
 * row read through the transaction, so concurrent writers serialize correctly
 * (STORE-9, NEW-STORE-2).
 */
export async function writeUpdateInTx(
	env: WriteEnv,
	scope: WriteScope,
	collection: string,
	id: string,
	data: Record<string, unknown>,
	extraCausalDeps: readonly string[] = [],
): Promise<WriteResult> {
	const definition = requireDefinition(env, collection)
	const currentRow = await readLiveRow(scope, collection, id)
	if (!currentRow) {
		throw new RecordNotFoundError(collection, id)
	}
	const currentRecord = deserializeRecord(currentRow, definition.fields)
	const allowed = validateUpdateStateMachine(collection, id, definition, currentRecord, data)
	if (Object.keys(allowed).length === 0) {
		return { operation: null, record: currentRecord, sideEffects: [] }
	}

	const previousData: Record<string, unknown> = {}
	const resolved: Record<string, unknown> = {}
	const atomicOps: Record<string, AtomicOp> = {}
	for (const [key, value] of Object.entries(allowed)) {
		previousData[key] = currentRecord[key]
		if (isAtomicOp(value)) {
			resolved[key] = resolveAtomicOp(currentRecord[key], value)
			atomicOps[key] = toAtomicOp(value)
		} else {
			resolved[key] = value
		}
	}
	// previousData already holds the stored (at-rest) values, so only the new
	// values need the secret transform.
	const writeData = await toAtRestWriteData(resolved, definition, env.secretKeyProvider)

	const operation = await buildLocalOperation(env, scope, {
		type: 'update',
		collection,
		recordId: id,
		data: encodeRichtextFieldsForOpData(writeData, definition.fields),
		previousData: encodeRichtextFieldsForOpData(previousData, definition.fields),
		extraCausalDeps,
		...(Object.keys(atomicOps).length > 0 ? { atomicOps } : {}),
	})

	if (env.fold) {
		await appendOperationRow(scope, operation)
		await env.fold.applyInTx(scope.tx, operation, 'local')
	} else {
		const serializedChanges = serializeRecord(writeData, definition.fields)
		const version = serializeRowVersion(operation.timestamp)
		// A local edit is the newest writer of every field it touches (the HLC is past
		// every timestamp this device has seen), so each changed field gets its stamp.
		const rowUpdate = buildUpdateQuery(collection, id, {
			...serializedChanges,
			_updated_at: operation.timestamp.wallTime,
			_version: version,
			_field_versions: stampFieldVersions(
				currentRow._field_versions,
				Object.keys(serializedChanges),
				version,
			),
		})
		await scope.tx.execute(rowUpdate.sql, rowUpdate.params)
		await appendOperationRow(scope, operation)
	}

	const updatedRow = await readLiveRow(scope, collection, id)
	if (!updatedRow) {
		throw new RecordNotFoundError(collection, id)
	}
	return {
		operation,
		record: deserializeRecord(updatedRow, definition.fields),
		sideEffects: [],
	}
}

/** Options for {@link writeDeleteInTx}. */
export interface WriteDeleteOptions {
	/** Skip referential checks and cascades (the caller already applied them). */
	readonly skipReferentialEnforcement?: boolean
	/** Explicit causal parents (e.g. the delete that caused this cascade). */
	readonly extraCausalDeps?: readonly string[]
}

/**
 * Soft-delete a record inside `scope.tx`, then apply the schema's referential
 * policies (cascade, set-null, restrict) in the same transaction. Cascaded
 * operations are built through this same write path, after the parent, so their
 * sequence numbers follow the parent's in the commit's block (STORE-2).
 */
export async function writeDeleteInTx(
	env: WriteEnv,
	scope: WriteScope,
	collection: string,
	id: string,
	options: WriteDeleteOptions = {},
): Promise<WriteResult> {
	const definition = requireDefinition(env, collection)
	const currentRow = await readLiveRow(scope, collection, id)
	if (!currentRow) {
		throw new RecordNotFoundError(collection, id)
	}
	const operation = await buildLocalOperation(env, scope, {
		type: 'delete',
		collection,
		recordId: id,
		data: null,
		previousData: null,
		extraCausalDeps: options.extraCausalDeps ?? [],
	})

	if (!options.skipReferentialEnforcement && env.beforeLocalDelete) {
		await env.beforeLocalDelete(operation, scope.tx)
	}

	// The row is tombstoned BEFORE side effects run, so a reference cycle
	// (self-referencing or mutually-referencing records) cannot cascade back
	// into this record.
	if (env.fold) {
		await appendOperationRow(scope, operation)
		await env.fold.applyInTx(scope.tx, operation, 'local')
	} else {
		const version = serializeRowVersion(operation.timestamp)
		const softDelete = buildSoftDeleteQuery(collection, id, operation.timestamp.wallTime, version)
		await scope.tx.execute(softDelete.sql, softDelete.params)
		await appendOperationRow(scope, operation)
	}

	const sideEffects: Operation[] = []
	if (!options.skipReferentialEnforcement && env.relationEnforcer) {
		const result = await env.relationEnforcer.enforceDelete(
			collection,
			id,
			scope,
			env,
			operation.id,
		)
		sideEffects.push(...result.operations)
	}

	return {
		operation,
		record: deserializeRecord(currentRow, definition.fields),
		sideEffects,
	}
}

interface LocalOperationInput {
	type: Operation['type']
	collection: string
	recordId: string
	data: Record<string, unknown> | null
	previousData: Record<string, unknown> | null
	extraCausalDeps: readonly string[]
	atomicOps?: Record<string, AtomicOp>
}

/**
 * Reserve the next sequence number through the transaction, THEN build the
 * operation. The order matters: the operation is final the moment it exists.
 */
async function buildLocalOperation(
	env: WriteEnv,
	scope: WriteScope,
	input: LocalOperationInput,
): Promise<Operation> {
	const sequenceNumber = await scope.sequence.take()
	const causalDeps = scope.causal.depsFor(input.collection, input.extraCausalDeps)
	const operation = await createOperation(
		{
			nodeId: env.nodeId,
			type: input.type,
			collection: input.collection,
			recordId: input.recordId,
			data: input.data,
			previousData: input.previousData,
			sequenceNumber,
			causalDeps,
			schemaVersion: env.schema.version,
			...(input.atomicOps !== undefined ? { atomicOps: input.atomicOps } : {}),
			...(env.transactionId !== undefined ? { transactionId: env.transactionId } : {}),
			...(env.mutationName !== undefined ? { mutationName: env.mutationName } : {}),
		},
		env.clock,
	)
	scope.causal.record(input.collection, operation.id)
	return operation
}

async function appendOperationRow(scope: WriteScope, operation: Operation): Promise<void> {
	const opInsert = buildInsertQuery(
		`_kora_ops_${operation.collection}`,
		serializeOperation(operation) as unknown as Record<string, unknown>,
	)
	await scope.tx.execute(opInsert.sql, opInsert.params)
}

async function readLiveRow(
	scope: WriteScope,
	collection: string,
	id: string,
): Promise<RawCollectionRow | undefined> {
	const rows = await scope.tx.query<RawCollectionRow>(
		`SELECT * FROM ${quoteIdent(collection)} WHERE id = ? AND _deleted = 0`,
		[id],
	)
	return rows[0]
}

function requireDefinition(env: WriteEnv, collection: string): CollectionDefinition {
	const definition = env.schema.collections[collection]
	if (!definition) {
		throw new KoraError(
			`Unknown collection "${collection}". Available: ${Object.keys(env.schema.collections).join(', ')}`,
			'UNKNOWN_COLLECTION',
			{ collection },
		)
	}
	return definition
}
