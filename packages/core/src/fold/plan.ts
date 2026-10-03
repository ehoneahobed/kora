import type { CollectionDefinition, SchemaDefinition } from '../types'
import { planField } from './field-kind'
import { FOLD_STATE_VERSION, type FieldState, type FoldState } from './types'

/**
 * FNV-1a over UTF-16 code units: a stable, dependency-free text fingerprint. Must
 * stay identical to the server's (`@korajs/server` `record-fold.ts`), so a client
 * and a server agree on whether a plan changed.
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
 * The fold plan of one collection as text: every field's kind, merge strategy and
 * resolver source. Two schemas fold a collection's stored states identically iff
 * these are equal.
 */
export function collectionFoldPlanFingerprint(
	name: string,
	collection: CollectionDefinition,
): string {
	const fields = Object.keys(collection.fields)
		.sort()
		.map((field) => {
			const descriptor = collection.fields[field]
			const resolver = collection.resolvers?.[field]
			return `${field}:${descriptor?.kind ?? ''}:${descriptor?.mergeStrategy ?? ''}:${
				resolver ? hashText(String(resolver)) : ''
			}`
		})
	const resolverOnly = Object.keys(collection.resolvers ?? {})
		.filter((field) => !(field in collection.fields))
		.sort()
		.map((field) => `${field}:resolver:${hashText(String(collection.resolvers?.[field]))}`)
	return `${name}(${[...fields, ...resolverOnly].join(',')})`
}

/**
 * Fingerprint of how a schema folds records (W7): the fold-state format version
 * plus every collection's {@link collectionFoldPlanFingerprint}. When it changes
 * (a field becomes `merge('counter')`, an array becomes append-only, a resolver is
 * added or edited), stored fold states may hold fields of another kind and must be
 * re-folded. The same definition as the server stores' `fold_plan_fingerprint`.
 *
 * @param schema - The schema
 */
export function foldPlanFingerprint(schema: SchemaDefinition): string {
	const parts: string[] = [`fold-v${FOLD_STATE_VERSION}`]
	for (const name of Object.keys(schema.collections).sort()) {
		const collection = schema.collections[name]
		if (!collection) continue
		parts.push(collectionFoldPlanFingerprint(name, collection))
	}
	return parts.join('|')
}

/**
 * Per-collection fold plan fingerprints, to find which collections a schema change
 * re-plans (only their records need re-folding).
 *
 * @param schema - The schema
 * @returns Collection name -> fingerprint (format version included)
 */
export function foldPlanFingerprints(schema: SchemaDefinition): Record<string, string> {
	const out: Record<string, string> = {}
	for (const name of Object.keys(schema.collections).sort()) {
		const collection = schema.collections[name]
		if (!collection) continue
		out[name] = `fold-v${FOLD_STATE_VERSION}|${collectionFoldPlanFingerprint(name, collection)}`
	}
	return out
}

/** Whether a stored field state has the kind the schema folds the field as now. */
export function fieldStateMatchesPlan(
	collection: CollectionDefinition | undefined,
	field: string,
	state: FieldState,
): boolean {
	const plan = planField(collection, field)
	if (state.k !== plan.kind) return false
	return state.k !== 'set' || state.ao === plan.appendOnly
}

/**
 * The fields of a stored fold state whose kind no longer matches the schema (empty
 * when the state can be merged into as-is).
 *
 * @param state - A stored fold state
 * @param schema - The current schema
 */
export function mismatchedFoldFields(state: FoldState, schema: SchemaDefinition): string[] {
	const collection = schema.collections[state.c]
	return Object.keys(state.f)
		.filter((field) => !fieldStateMatchesPlan(collection, field, state.f[field] as FieldState))
		.sort()
}
