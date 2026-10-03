import {
	createFoldState,
	foldRecord,
	joinStates,
	materialize,
	mergeOp,
} from '../../../src/fold/fold'
import { deserializeFoldState, serializeFoldState } from '../../../src/fold/serialize'
import type { FoldState } from '../../../src/fold/types'
import type { Operation, SchemaDefinition } from '../../../src/types'
import { type FoldUnderTest, GATE_AUTHORITATIVE_NODES, fakeRichtextMerger } from './harness'

/**
 * The W7 fold wired into the gate harness, folding with `authoritative` as the
 * explicit authoritative node list (`kora:server:` nodes are authoritative anyway).
 */
export function makeW7Fold(
	authoritative: ReadonlySet<string> = GATE_AUTHORITATIVE_NODES,
): FoldUnderTest {
	const options = { richtext: fakeRichtextMerger, authoritativeNodeIds: authoritative }
	const foldState = (ops: readonly Operation[], schema: SchemaDefinition): FoldState =>
		foldRecord(ops, schema, options).state ?? createFoldState('items', 'rec-1')
	return {
		name: 'W7 per-field CRDT fold',
		replica(schema) {
			let state = createFoldState('items', 'rec-1')
			return {
				apply(op) {
					state = mergeOp(state, op, schema, { ...options, traces: 'all' }).state
				},
				reload() {
					state = deserializeFoldState(serializeFoldState(state))
				},
				materialize: () => materialize(state, options),
				stateKey: () => serializeFoldState(state),
			}
		},
		fold(ops, schema, exclude) {
			const state = foldRecord(ops, schema, { ...options, exclude }).state
			return state === null ? null : materialize(state, options)
		},
		joinFold(parts, schema, grouping) {
			const [a, b, c] = parts.map((part) => foldState(part, schema)) as [
				FoldState,
				FoldState,
				FoldState,
			]
			const joined =
				grouping === 'left'
					? joinStates(joinStates(a, b, schema), c, schema)
					: joinStates(a, joinStates(c, b, schema), schema)
			return materialize(joined, options)
		},
	}
}

/** The W7 fold with the gate's default authoritative node list. */
export const w7Fold: FoldUnderTest = makeW7Fold()
