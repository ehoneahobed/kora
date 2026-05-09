import { HybridLogicalClock, validateTransition } from '@korajs/core'
import type {
	CollectionDefinition,
	Operation,
	StateMachineConstraint,
	StateMachineDefinition,
} from '@korajs/core'
import type { MergeTrace } from '@korajs/core'

/**
 * Helper: check if a transition is valid for a given state machine definition.
 * Wraps validateTransition to return a simple boolean.
 */
function isValid(sm: StateMachineDefinition, from: string, to: string): boolean {
	const constraint: StateMachineConstraint = {
		field: sm.field,
		collection: '',
		transitions: sm.transitions,
	}
	return validateTransition(constraint, from, to).valid
}

/**
 * Result of state machine merge validation.
 */
export interface StateMachineMergeResult {
	/** The resolved value for the state field */
	value: string
	/** Trace for DevTools */
	trace: MergeTrace
}

/**
 * Validates and resolves concurrent state machine transitions during merge.
 *
 * When two operations concurrently modify a state-machine-controlled field,
 * this function determines the correct resolved value:
 *
 * 1. Both transitions valid from base state: use LWW (HLC timestamp) to pick the winner
 * 2. One transition valid, one invalid: the valid transition wins
 * 3. Both transitions invalid: keep the base state and report the constraint violation
 *
 * @param fieldName - The state machine field name
 * @param localOp - The local operation
 * @param remoteOp - The remote operation
 * @param baseState - The record state before either operation (contains the base state value)
 * @param stateMachine - The state machine definition
 * @returns The resolved state value and a trace
 */
export function resolveStateMachineMerge(
	fieldName: string,
	localOp: Operation,
	remoteOp: Operation,
	baseState: Record<string, unknown>,
	stateMachine: StateMachineDefinition,
): StateMachineMergeResult {
	const startTime = Date.now()
	const baseValue = baseState[fieldName]

	const localData = localOp.data ?? {}
	const remoteData = remoteOp.data ?? {}

	const localValue = localData[fieldName]
	const remoteValue = remoteData[fieldName]

	// Determine base state string
	const baseStateStr = typeof baseValue === 'string' ? baseValue : ''
	const localStr = typeof localValue === 'string' ? localValue : baseStateStr
	const remoteStr = typeof remoteValue === 'string' ? remoteValue : baseStateStr

	const localChanged = fieldName in localData
	const remoteChanged = fieldName in remoteData

	// Non-conflict: only one side changed
	if (localChanged && !remoteChanged) {
		const valid = isValid(stateMachine, baseStateStr, localStr)
		return makeResult(
			valid ? localStr : baseStateStr,
			fieldName,
			localOp,
			remoteOp,
			localValue,
			baseValue,
			baseValue,
			valid ? 'state-machine-no-conflict-local' : 'state-machine-invalid-local',
			valid ? null : `Invalid transition from "${baseStateStr}" to "${localStr}"`,
			startTime,
		)
	}

	if (!localChanged && remoteChanged) {
		const valid = isValid(stateMachine, baseStateStr, remoteStr)
		return makeResult(
			valid ? remoteStr : baseStateStr,
			fieldName,
			localOp,
			remoteOp,
			baseValue,
			remoteValue,
			baseValue,
			valid ? 'state-machine-no-conflict-remote' : 'state-machine-invalid-remote',
			valid ? null : `Invalid transition from "${baseStateStr}" to "${remoteStr}"`,
			startTime,
		)
	}

	if (!localChanged && !remoteChanged) {
		return makeResult(
			baseStateStr,
			fieldName,
			localOp,
			remoteOp,
			baseValue,
			baseValue,
			baseValue,
			'state-machine-no-conflict-unchanged',
			null,
			startTime,
		)
	}

	// Both sides changed -- validate both transitions from base state
	const localValid = isValid(stateMachine, baseStateStr, localStr)
	const remoteValid = isValid(stateMachine, baseStateStr, remoteStr)

	if (localValid && remoteValid) {
		// Both valid: LWW by HLC timestamp decides the winner
		const comparison = HybridLogicalClock.compare(localOp.timestamp, remoteOp.timestamp)
		const winner = comparison >= 0 ? localStr : remoteStr
		return makeResult(
			winner,
			fieldName,
			localOp,
			remoteOp,
			localValue,
			remoteValue,
			baseValue,
			'state-machine-lww',
			null,
			startTime,
		)
	}

	if (localValid && !remoteValid) {
		// Only local is valid: local wins regardless of timestamp
		return makeResult(
			localStr,
			fieldName,
			localOp,
			remoteOp,
			localValue,
			remoteValue,
			baseValue,
			'state-machine-valid-wins',
			`Remote transition from "${baseStateStr}" to "${remoteStr}" is invalid; local "${localStr}" wins`,
			startTime,
		)
	}

	if (!localValid && remoteValid) {
		// Only remote is valid: remote wins regardless of timestamp
		return makeResult(
			remoteStr,
			fieldName,
			localOp,
			remoteOp,
			localValue,
			remoteValue,
			baseValue,
			'state-machine-valid-wins',
			`Local transition from "${baseStateStr}" to "${localStr}" is invalid; remote "${remoteStr}" wins`,
			startTime,
		)
	}

	// Both invalid: keep base state
	return makeResult(
		baseStateStr,
		fieldName,
		localOp,
		remoteOp,
		localValue,
		remoteValue,
		baseValue,
		'state-machine-both-invalid',
		`Both transitions invalid from "${baseStateStr}": local to "${localStr}", remote to "${remoteStr}". Keeping base state.`,
		startTime,
	)
}

/**
 * Checks whether a collection has a state machine defined and whether the given
 * field is the state machine field. Used by the merge engine to intercept
 * field-level merges for state machine fields.
 */
export function isStateMachineField(
	collectionDef: CollectionDefinition,
	fieldName: string,
): boolean {
	return collectionDef.stateMachine !== undefined && collectionDef.stateMachine.field === fieldName
}

function makeResult(
	value: string,
	field: string,
	operationA: Operation,
	operationB: Operation,
	inputA: unknown,
	inputB: unknown,
	base: unknown,
	strategy: string,
	constraintViolated: string | null,
	startTime: number,
): StateMachineMergeResult {
	const trace: MergeTrace = {
		operationA,
		operationB,
		field,
		strategy,
		inputA,
		inputB,
		base,
		output: value,
		tier: 2,
		constraintViolated,
		duration: Date.now() - startTime,
	}
	return { value, trace }
}
