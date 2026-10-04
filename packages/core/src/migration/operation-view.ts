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

/**
 * Thrown when stored operations have a schema version the registered transforms cannot
 * read (RT-103): starting would fold those operations as absent and silently erase them
 * from every record they belong to.
 */
export class OperationTransformCoverageError extends KoraError {
	constructor(
		message: string,
		public readonly versions: readonly number[],
		public readonly targetSchemaVersion: number,
		context: Record<string, unknown> = {},
	) {
		super(message, 'OPERATION_TRANSFORM_MISSING', {
			...context,
			versions: [...versions],
			targetSchemaVersion,
			fix: `Keep a transform path registered from every schema version in the operation log to v${targetSchemaVersion} (a transform must stay registered as long as operations of its source version exist, and the log is append-only), or register no transforms at all (operations then fold as written).`,
		})
		this.name = 'OperationTransformCoverageError'
	}
}

/**
 * The stored schema versions the transforms have no path from (RT-103). Mirrors the
 * path {@link operationSchemaView} follows (`fromVersion` to `toVersion`, at most 32
 * steps). An empty transform list reads everything (operations fold as written).
 *
 * @param storedVersions - Distinct schema versions of the stored operations
 * @param targetSchemaVersion - The replica's schema version
 * @param transforms - The registered transforms
 * @returns Each version with no path and the version whose transform is missing, ascending
 */
export function missingTransformPaths(
	storedVersions: Iterable<number>,
	targetSchemaVersion: number,
	transforms: readonly OperationTransform[] | undefined,
): Array<{ version: number; missingFrom: number }> {
	if (transforms === undefined || transforms.length === 0) return []
	const missing: Array<{ version: number; missingFrom: number }> = []
	for (const version of new Set(storedVersions)) {
		if (version === targetSchemaVersion) continue
		let current = version
		let reached = false
		for (let step = 0; step < 32; step++) {
			if (current === targetSchemaVersion) {
				reached = true
				break
			}
			const next = transforms.find((candidate) => candidate.fromVersion === current)
			if (!next) break
			current = next.toVersion
		}
		if (!reached) missing.push({ version, missingFrom: current })
	}
	return missing.sort((a, b) => a.version - b.version)
}

/**
 * Refuse to start a replica whose transforms cannot read operations it stores (RT-103).
 *
 * @param storedVersions - Distinct schema versions of the stored operations
 * @param targetSchemaVersion - The replica's schema version
 * @param transforms - The registered transforms
 * @param replica - Names the replica in the message ("server store", "local database")
 * @throws {OperationTransformCoverageError} When a stored version has no path
 */
export function assertOperationTransformCoverage(
	storedVersions: Iterable<number>,
	targetSchemaVersion: number,
	transforms: readonly OperationTransform[] | undefined,
	replica: string,
): void {
	const missing = missingTransformPaths(storedVersions, targetSchemaVersion, transforms)
	if (missing.length === 0) return
	const versions = missing.map((entry) => entry.version)
	const steps = [...new Set(missing.map((entry) => entry.missingFrom))]
	const plural = versions.length > 1
	throw new OperationTransformCoverageError(
		`The ${replica} holds operations of schema version${plural ? 's' : ''} ${versions.map((v) => `v${v}`).join(', ')}, but the registered operationTransforms have no path from ${plural ? 'them' : 'it'} to the current schema v${targetSchemaVersion} (no transform from ${steps.map((v) => `v${v}`).join(', ')}). Starting would silently drop those operations from their records, so it is refused. Keep the retired transform(s) registered: a transform may be removed only after every operation of its source version has been folded into snapshots by an explicit compaction.`,
		versions,
		targetSchemaVersion,
		{ replica, missingFrom: steps },
	)
}
