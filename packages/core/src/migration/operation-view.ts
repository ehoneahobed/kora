import { KoraError } from '../errors/errors'
import { canonicalizeOperationBody } from '../operations/canonical-body'
import type { Operation } from '../types'
import { applyOperationTransforms } from './apply-operation-transforms'
import type { OperationTransform } from './operation-transform'

/**
 * Thrown when a schema transform breaks its contract: it changed an operation's
 * identity (id, node, type, collection, record or timestamp), or produced a body with
 * no canonical JSON form.
 */
export class OperationTransformError extends KoraError {
	constructor(message: string, context: Record<string, unknown>) {
		super(message, 'INVALID_OPERATION_TRANSFORM', {
			...context,
			fix: 'An OperationTransform may rewrite data, previousData, atomicOps and schemaVersion only, deterministically, with JSON values.',
		})
		this.name = 'OperationTransformError'
	}
}

/**
 * The operation as a schema reads it: its schema view (transforms at fold time).
 *
 * Operations are immutable and content-addressed, so a schema transform never rewrites
 * a stored operation. Every replica (server stores and devices alike) stores and sends
 * the operation exactly as its author wrote it, and applies the transform chain only
 * when it judges or folds the operation, through this one function:
 * - the server authorizes and validates the view, and its stores fold the view;
 * - a device folds the view; an operation with no view (no transform path, e.g. one
 *   authored under a NEWER schema than the device's) is kept aside and replayed after
 *   the device upgrades.
 *
 * Contract, enforced here:
 * - transforms are PURE and DETERMINISTIC: the same operation and transforms give the
 *   same view on every replica, at every time (no clock, randomness or I/O). Every
 *   replica must register the same transforms for the schema versions its log holds;
 *   the fold plan fingerprint includes them, so changing a transform re-folds;
 * - a transform rewrites `data`, `previousData`, `atomicOps` and `schemaVersion` only. A
 *   view whose id, node, type, collection, record or timestamp differs is refused
 *   ({@link OperationTransformError});
 * - the view's body is canonical (core canonical-body), like any written body.
 *
 * Returned unchanged: an operation already at `targetSchemaVersion`, any operation
 * when no transform is registered (it folds as written), and an encryption envelope the
 * caller cannot read (`encrypted` set: the server folds its cleartext header as is;
 * devices transform after decryption).
 *
 * @param op - The operation as stored
 * @param targetSchemaVersion - The schema version of the replica judging or folding it
 * @param transforms - The registered transforms
 * @returns The view, or null when a transform drops the operation or no path exists
 * @throws {OperationTransformError} When a transform breaks the contract above
 */
export function operationSchemaView(
	op: Operation,
	targetSchemaVersion: number,
	transforms: readonly OperationTransform[] | undefined,
): Operation | null {
	if (op.schemaVersion === targetSchemaVersion) return op
	if (transforms === undefined || transforms.length === 0) return op
	if (op.encrypted !== undefined) return op
	let view: Operation | null
	try {
		view = applyOperationTransforms(op, targetSchemaVersion, transforms)
	} catch (error) {
		throw new OperationTransformError(
			`The schema transform of operation ${op.id} (schema v${op.schemaVersion} -> v${targetSchemaVersion}) threw: ${error instanceof Error ? error.message : String(error)}`,
			{ operationId: op.id, fromVersion: op.schemaVersion, toVersion: targetSchemaVersion },
		)
	}
	if (view === null || view === op) return view
	for (const key of ['id', 'nodeId', 'type', 'collection', 'recordId'] as const) {
		if (view[key] !== op[key]) {
			throw new OperationTransformError(
				`The schema transform of operation ${op.id} changed its ${key} ("${String(op[key])}" -> "${String(view[key])}"). A transform may rewrite data, previousData, atomicOps and schemaVersion only.`,
				{ operationId: op.id, field: key },
			)
		}
	}
	const a = op.timestamp
	const b = view.timestamp
	if (a.wallTime !== b.wallTime || a.logical !== b.logical || a.nodeId !== b.nodeId) {
		throw new OperationTransformError(
			`The schema transform of operation ${op.id} changed its timestamp. A transform may rewrite data, previousData, atomicOps and schemaVersion only.`,
			{ operationId: op.id, field: 'timestamp' },
		)
	}
	try {
		return canonicalizeOperationBody(view)
	} catch (error) {
		throw new OperationTransformError(
			`The schema transform of operation ${op.id} produced a value with no JSON form: ${error instanceof Error ? error.message : String(error)}`,
			{ operationId: op.id },
		)
	}
}

/**
 * FNV-1a over UTF-16 code units (same definition as the fold plan fingerprint).
 */
function hashText(text: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(16).padStart(8, '0')
}

/**
 * Fingerprint of a transform chain for a target schema version: '' when no transform
 * is registered (operations fold as written, whatever the target), otherwise the
 * target version and each transform's versions and source text. Part of the fold plan
 * fingerprint, so a replica re-folds when its views change.
 *
 * @param targetSchemaVersion - The replica's schema version
 * @param transforms - The registered transforms
 */
export function operationTransformsFingerprint(
	targetSchemaVersion: number,
	transforms: readonly OperationTransform[] | undefined,
): string {
	if (transforms === undefined || transforms.length === 0) return ''
	const parts = transforms
		.map((t) => `${t.fromVersion}>${t.toVersion}:${hashText(String(t.transform))}`)
		.sort()
	return `xf@v${targetSchemaVersion}(${parts.join(',')})`
}
