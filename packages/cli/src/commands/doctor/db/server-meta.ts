import { foldPlanFingerprint } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'

/*
 * What `kora doctor --db` knows about a Kora server database's layout. `@korajs/cli` may
 * not depend on `@korajs/server` at runtime (CLAUDE.md dependency rules), so the meta keys
 * and the scope-snapshot fingerprint are restated here; `server-meta.test.ts` asserts they
 * equal the server's own definitions, so a change there fails the build here.
 */

/** `kora_server_meta`: fold plan fingerprint the stored fold states were built under. */
export const FOLD_PLAN_FINGERPRINT_KEY = 'fold_plan_fingerprint'
/**
 * `kora_server_meta`: JSON map of each collection's server fold plan fingerprint. Present
 * on a database a server with per-collection plans wrote: its next start re-folds only the
 * collections whose plan changed, and each fold state is stamped with its collection's plan.
 */
export const FOLD_PLAN_FINGERPRINTS_KEY = 'fold_plan_fingerprints'
/** `kora_server_meta`: fields the per-operation scope snapshots capture. */
export const SCOPE_SNAPSHOT_FINGERPRINT_KEY = 'scope_snapshot_fields'
/** `kora_server_meta`: JSON map of {@link scopeSnapshotFingerprints} (per-collection snapshots). */
export const SCOPE_SNAPSHOT_FINGERPRINTS_KEY = 'scope_snapshot_fields_by_collection'
/**
 * `kora_server_meta`: the fingerprint a scope snapshot rebuild dropped snapshots for;
 * set while that rebuild is unfinished (a restart resumes it at the missing snapshots).
 */
export const SCOPE_SNAPSHOT_PENDING_KEY = 'scope_snapshot_fields_pending'
/** `kora_server_meta`: one-time log integrity scan done (value: ms of the first beta.13+ start). */
export const SERVER_LOG_INTEGRITY_META_KEY = 'log_integrity_scan_v1'
/** `kora_server_meta`: legacy server authority scan done (value: ms of the first beta.13+ start). */
export const SERVER_LEGACY_SCAN_KEY = 'server_legacy_authority_scan_v1'
/** `kora_server_meta`: JSON array of legacy server node ids. */
export const SERVER_LEGACY_AUTHORITY_KEY = 'server_legacy_authoritative_node_ids'
/** `kora_server_meta`: JSON array of every explicit server node id ever held authoritative. */
export const SERVER_EVER_AUTHORITY_KEY = 'server_ever_authoritative_node_ids'
/** Node ids Kora itself authors under (server instances, markers); never a device. */
export const RESERVED_NODE_PREFIX = 'kora:'
/** Owner of a node claim an administrator released. */
export const RELEASED_NODE_OWNER = ''
/** Table holding rows the log integrity scan could not read. */
export const SERVER_LOG_QUARANTINE_TABLE = 'operations_quarantine'

const SNAPSHOT_KINDS = new Set(['string', 'number', 'boolean', 'enum', 'timestamp'])

/**
 * The scope-snapshot fingerprint the server stores compute (`@korajs/server`
 * `scopeSnapshotFingerprint`): when the stored one differs, the next start drops and
 * rebuilds every operation's scope snapshot.
 */
export function scopeSnapshotFingerprint(schema: SchemaDefinition): string {
	const parts = Object.keys(schema.collections)
		.sort()
		.map((collection) => collectionCapture(schema, collection))
	return `v1|${parts.join('|')}`
}

/**
 * Per-collection scope-snapshot fingerprints (`@korajs/server` `scopeSnapshotFingerprints`):
 * a server that records them drops and rebuilds only the changed collections' snapshots.
 */
export function scopeSnapshotFingerprints(schema: SchemaDefinition): Record<string, string> {
	const out: Record<string, string> = {}
	for (const collection of Object.keys(schema.collections).sort()) {
		out[collection] = `v1|${collectionCapture(schema, collection)}`
	}
	return out
}

function collectionCapture(schema: SchemaDefinition, collection: string): string {
	const fields = schema.collections[collection]?.fields ?? {}
	const captured = Object.keys(fields)
		.filter((name) => SNAPSHOT_KINDS.has(fields[name]?.kind ?? ''))
		.sort()
		.map((name) => `${name}:${fields[name]?.kind ?? ''}`)
	return `${collection}(${captured.join(',')})`
}

/** A fold plan fingerprint split into what the doctor can compare. */
export interface ParsedFoldPlan {
	/** `fold-vN`: the fold-state format. */
	format: string
	/** Collection name -> its plan with resolver hashes removed. */
	collections: Map<string, string>
	/** True when the server folds with operation transforms (the doctor cannot see them). */
	hasTransforms: boolean
}

/**
 * Parse a fold plan fingerprint (the server's stored one, or core's for the app schema).
 * Resolver hashes are dropped on both sides: a schema loaded from TypeScript reaches the
 * CLI as JSON, without its resolver functions, so comparing them would report a re-fold
 * that the server will not do. Kinds and merge strategies are compared exactly.
 */
export function parseFoldPlan(fingerprint: string): ParsedFoldPlan {
	const parts = fingerprint.split('|')
	const collections = new Map<string, string>()
	let hasTransforms = false
	for (const part of parts.slice(1)) {
		if (part.startsWith('auth:')) continue
		if (part.startsWith('xf@')) {
			hasTransforms = true
			continue
		}
		const open = part.indexOf('(')
		if (open < 0 || !part.endsWith(')')) continue
		const name = part.slice(0, open)
		const fields = part
			.slice(open + 1, -1)
			.split(',')
			.filter((entry) => entry.length > 0 && !entry.includes(':resolver:'))
			// field:kind:strategy:resolverHash -> field:kind:strategy
			.map((entry) => entry.split(':').slice(0, 3).join(':'))
		collections.set(name, fields.join(','))
	}
	return { format: parts[0] ?? '', collections, hasTransforms }
}

/**
 * The collections whose fold plan differs between the stored fingerprint and the app
 * schema (or every one, when the fold-state format changed). Empty when nothing re-plans.
 */
export function replannedCollections(
	stored: string,
	schema: SchemaDefinition,
): { collections: string[]; formatChanged: boolean; hasTransforms: boolean } {
	const before = parseFoldPlan(stored)
	const after = parseFoldPlan(foldPlanFingerprint(schema))
	const formatChanged = before.format !== after.format
	const collections = [...after.collections.keys()].filter(
		(name) => formatChanged || before.collections.get(name) !== after.collections.get(name),
	)
	// A collection the server folded that the app dropped changes the fingerprint too.
	const removed = [...before.collections.keys()].filter((name) => !after.collections.has(name))
	return {
		collections: [...collections, ...removed.map((name) => `${name} (removed)`)],
		formatChanged,
		hasTransforms: before.hasTransforms,
	}
}
