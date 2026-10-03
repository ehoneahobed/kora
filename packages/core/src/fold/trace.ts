import type { MergeTrace } from '../events/events'
import type { Operation } from '../types'
import type { FoldTrace } from './types'

/**
 * Turn a {@link FoldTrace} into the {@link MergeTrace} DevTools and `merge:*`
 * events consume. `operationA` is the operation that last wrote the field before
 * the merge; the fold state only keeps its id (`trace.priorOperationId`), so the
 * caller looks it up in its operation log. When it is unavailable (compacted, or
 * the field had no prior value) the incoming operation stands in for it, and
 * `inputA` still carries the prior value.
 *
 * @param trace - A trace from `mergeOp`
 * @param operationA - The operation that produced the field's prior value, if known
 */
export function toMergeTrace(trace: FoldTrace, operationA?: Operation | null): MergeTrace {
	return {
		operationA: operationA ?? trace.operation,
		operationB: trace.operation,
		field: trace.field,
		strategy: trace.strategy,
		inputA: trace.inputA,
		inputB: trace.inputB,
		base: trace.base,
		output: trace.output,
		tier: trace.tier,
		constraintViolated: trace.constraintViolated,
		duration: trace.duration,
	}
}
