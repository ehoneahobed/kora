import type { CollectionDefinition, CustomResolver } from '../types'
import type { FoldFieldKind } from './types'

/** How the fold merges one field, derived from the schema. */
export interface FieldPlan {
	kind: FoldFieldKind
	/** For 'set': removals are ignored (`merge('append-only')`). */
	appendOnly: boolean
	/** For 'res': the custom resolver. */
	resolver?: CustomResolver
	/** Name of the strategy for traces. */
	strategy: string
	/** Tier for traces: 3 for custom resolvers, 1 otherwise. */
	tier: 1 | 3
	/** Secret field: values are redacted from traces. */
	secret: boolean
	/** `merge('server-authoritative')`: writes of authoritative nodes win (class 1 stamps). */
	authoritative?: boolean
}

const LWW_PLAN: FieldPlan = {
	kind: 'reg',
	appendOnly: false,
	strategy: 'lww',
	tier: 1,
	secret: false,
}

/**
 * Decide how a field is folded. Precedence matches the pairwise engine it
 * replaces: a custom resolver (tier 3), then a schema-declared merge strategy,
 * then the field kind's default.
 *
 * | Schema | Fold kind |
 * |---|---|
 * | `resolve: { field }` | 'res' (resolver over the write log) |
 * | `merge('counter')` | 'ctr' (base + deltas) |
 * | `merge('max')` / `merge('min')` | 'max' / 'min' |
 * | array, `merge('append-only')` | 'set' with removals ignored |
 * | array (default or `merge('union')`) | 'set' (LWW element set) |
 * | object / json | 'map' (per-top-level-key LWW) |
 * | richtext | 'rt' (Yjs updates + string reset register) |
 * | `merge('server-authoritative')` | 'reg' with authority-classed stamps |
 * | everything else, `merge('lww')` | 'reg' |
 *
 * A field that is not in the schema (an older schema version's field, or an
 * unknown collection) folds as a last-write-wins register.
 *
 * @param collection - The collection definition, if the schema has it
 * @param field - The field name
 */
export function planField(collection: CollectionDefinition | undefined, field: string): FieldPlan {
	const descriptor = collection?.fields[field]
	const secret = descriptor?.kind === 'secret'
	const resolver = collection?.resolvers?.[field]
	if (resolver) {
		return { kind: 'res', appendOnly: false, resolver, strategy: 'custom', tier: 3, secret }
	}
	if (!descriptor) return LWW_PLAN
	switch (descriptor.mergeStrategy) {
		case 'counter':
			return { kind: 'ctr', appendOnly: false, strategy: 'schema-counter', tier: 1, secret }
		case 'max':
			return { kind: 'max', appendOnly: false, strategy: 'schema-max', tier: 1, secret }
		case 'min':
			return { kind: 'min', appendOnly: false, strategy: 'schema-min', tier: 1, secret }
		case 'append-only':
			if (descriptor.kind === 'array') {
				return {
					kind: 'set',
					appendOnly: true,
					strategy: 'schema-append-only',
					tier: 1,
					secret,
				}
			}
			return { ...LWW_PLAN, secret }
		case 'lww':
			return { ...LWW_PLAN, secret }
		case 'server-authoritative':
			// A register whose writes from authoritative nodes (FoldOptions.
			// authoritativeNodeIds: the server's node ids) beat every other write,
			// whatever their HLC. Within a class, last write wins.
			return {
				...LWW_PLAN,
				strategy: 'schema-server-authoritative',
				secret,
				authoritative: true,
			}
		default:
			break
	}
	switch (descriptor.kind) {
		case 'array':
			return { kind: 'set', appendOnly: false, strategy: 'lww-element-set', tier: 1, secret }
		case 'object':
		case 'json':
			return { kind: 'map', appendOnly: false, strategy: 'object-key-lww', tier: 1, secret }
		case 'richtext':
			return { kind: 'rt', appendOnly: false, strategy: 'crdt-text', tier: 1, secret }
		default:
			return { ...LWW_PLAN, secret }
	}
}
